// ─────────────────────────────────────────────────────────────────────────
// Interaction semantics (Phase 5). Runs in the content script and records the
// reproduction steps Claude restates: clicks, inputs (masked), scrolls, and
// navigations — plus two derived, high-signal flags:
//
//   • rage click — ≥3 clicks on the same target in ~1s (user frustration)
//   • dead click — a click that produced no DOM change / navigation (likely a
//     broken handler). We defer emitting each click by a short window so both
//     flags can be resolved before the event is sent.
//
// Also builds a compact accessibility snapshot of the DOM on demand (the
// background asks for one when an uncaught error fires).
// ─────────────────────────────────────────────────────────────────────────

import type { ElementInfo, InteractionEvent } from '@/shared/types'
import { describeInMain } from './main-bridge'

const DEAD_WINDOW_MS = 1200
const RAGE_WINDOW_MS = 1000
const RAGE_THRESHOLD = 3
const SCROLL_THROTTLE_MS = 600
const NAV_POLL_MS = 700
const MAX_SCROLLS = 40

type Emit = (e: InteractionEvent) => void

export class InteractionTracker {
  private startEpoch = 0
  private emit: Emit
  private active = false

  private mutationSeq = 0
  private observer?: MutationObserver
  private recentClicks: { t: number; sig: string }[] = []
  private lastScrollAt = 0
  private scrollCount = 0
  private lastUrl = location.href
  private navTimer?: ReturnType<typeof setInterval>

  private onClick = this.handleClick.bind(this)
  private onChange = this.handleChange.bind(this)
  private onScroll = this.handleScroll.bind(this)

  constructor(emit: Emit) {
    this.emit = emit
  }

  start(startEpoch: number): void {
    if (this.active) return
    this.active = true
    this.startEpoch = startEpoch
    this.lastUrl = location.href

    this.observer = new MutationObserver(() => {
      this.mutationSeq++
    })
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })

    document.addEventListener('click', this.onClick, true)
    document.addEventListener('change', this.onChange, true)
    window.addEventListener('scroll', this.onScroll, true)
    this.navTimer = setInterval(() => this.pollNavigation(), NAV_POLL_MS)

    // Breadcrumb for the current page — this is how full-page navigations show
    // up in the timeline (each new page re-arms the tracker on load).
    this.emit({
      id: newId('int'),
      kind: 'interaction',
      tMs: this.tMs(),
      action: 'navigation',
      url: location.href,
      label: document.title,
    })
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.observer?.disconnect()
    document.removeEventListener('click', this.onClick, true)
    document.removeEventListener('change', this.onChange, true)
    window.removeEventListener('scroll', this.onScroll, true)
    if (this.navTimer) clearInterval(this.navTimer)
  }

  private tMs(): number {
    return Date.now() - this.startEpoch
  }

  // ── clicks (with rage + dead detection) ─────────────────────────────────

  private handleClick(e: MouseEvent): void {
    const el = e.target as Element | null
    if (!el || isOurUi(el)) return

    const t = this.tMs()
    const sig = selectorFor(el)
    this.recentClicks.push({ t, sig })
    this.recentClicks = this.recentClicks.filter((c) => t - c.t <= RAGE_WINDOW_MS)

    const beforeMutation = this.mutationSeq
    const beforeUrl = location.href
    const label = labelFor(el)
    const x = e.clientX
    const y = e.clientY
    // Measure the rect NOW — by the deferred callback the click may have
    // detached/re-rendered the node, yielding a bogus {0,0,0,0}.
    const rectNow = rectOf(el)

    // Defer so DOM mutations / navigation that the click triggers can settle;
    // during the wait, resolve the element's full identity (incl. component).
    window.setTimeout(async () => {
      const rageCount = this.recentClicks.filter((c) => c.sig === sig).length
      const rage = rageCount >= RAGE_THRESHOLD
      const changed = this.mutationSeq !== beforeMutation || location.href !== beforeUrl
      const dead = !changed && !isFormControl(el)
      const element = await describeElement(el, x, y, rectNow)
      this.emit({
        id: newId('int'),
        kind: 'interaction',
        tMs: t,
        action: 'click',
        target: sig,
        label,
        x,
        y,
        rage,
        dead,
        element,
      })
    }, DEAD_WINDOW_MS)
  }

  // ── inputs (masked) ──────────────────────────────────────────────────────

  private handleChange(e: Event): void {
    const el = e.target as HTMLElement | null
    if (!el || isOurUi(el)) return
    const tag = el.tagName.toLowerCase()
    if (!['input', 'select', 'textarea'].includes(tag)) return

    this.emit({
      id: newId('int'),
      kind: 'interaction',
      tMs: this.tMs(),
      action: 'input',
      target: selectorFor(el),
      label: labelFor(el),
      value: maskedValue(el),
    })
  }

  // ── scroll (throttled) ─────────────────────────────────────────────────

  private handleScroll(): void {
    const now = Date.now()
    if (now - this.lastScrollAt < SCROLL_THROTTLE_MS) return
    if (this.scrollCount >= MAX_SCROLLS) return
    this.lastScrollAt = now
    this.scrollCount++
    this.emit({
      id: newId('int'),
      kind: 'interaction',
      tMs: this.tMs(),
      action: 'scroll',
      value: `y=${Math.round(window.scrollY)}`,
    })
  }

  // ── navigation (polled — world-agnostic) ────────────────────────────────

  private pollNavigation(): void {
    if (location.href === this.lastUrl) return
    this.lastUrl = location.href
    this.emit({
      id: newId('int'),
      kind: 'interaction',
      tMs: this.tMs(),
      action: 'navigation',
      url: location.href,
    })
  }
}

// ── DOM accessibility snapshot ──────────────────────────────────────────────

const SNAPSHOT_SELECTOR =
  'a,button,input,select,textarea,summary,[role],[contenteditable="true"],main,nav,header,footer,form,dialog,h1,h2,h3'
const MAX_SNAPSHOT_LINES = 120
const MAX_SNAPSHOT_CHARS = 5000

/** Build a compact, LLM-friendly a11y tree (roles + names + states). */
export function buildDomSnapshot(): string {
  const nodes = Array.from(document.querySelectorAll(SNAPSHOT_SELECTOR))
  const lines: string[] = []
  for (const el of nodes) {
    if (lines.length >= MAX_SNAPSHOT_LINES) break
    if (isOurUi(el) || !isVisible(el)) continue
    const role = roleFor(el)
    const name = labelFor(el)
    const state = stateFor(el)
    const line = `${role}${name ? ` "${trim(name, 60)}"` : ''}${state}`
    lines.push(line)
  }
  let out = lines.join('\n')
  if (out.length > MAX_SNAPSHOT_CHARS) out = out.slice(0, MAX_SNAPSHOT_CHARS) + '\n…[truncated]'
  return out || '(no visible interactive elements)'
}

// ── helpers ────────────────────────────────────────────────────────────────

function isOurUi(el: Element): boolean {
  return !!el.closest('[data-claude-clip]')
}

function rectOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = (el as HTMLElement).getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}

/**
 * Full stable identity of an element: the isolated world resolves everything
 * from the DOM (selector, testid, aria, rect, path); the MAIN world adds the
 * React/Vue component name. `x`/`y` let the MAIN world re-find the element.
 */
export async function describeElement(
  el: Element,
  x?: number,
  y?: number,
  rectOverride?: { x: number; y: number; w: number; h: number },
): Promise<ElementInfo> {
  // Prefer a rect measured at event time; fall back to measuring now. Omit a
  // zero rect entirely rather than emitting a misleading {0,0,0,0}.
  const rect = rectOverride ?? rectOf(el)
  const info: ElementInfo = {
    tag: el.tagName.toLowerCase(),
    selector: selectorFor(el),
    testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
    elementId: el.id || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    role: el.getAttribute('role') || roleFor(el),
    text: trim(labelFor(el), 80) || undefined,
    domPath: domPath(el),
    rect: rect.w > 0 || rect.h > 0 ? rect : undefined,
  }
  const px = x ?? rect.x + rect.w / 2
  const py = y ?? rect.y + rect.h / 2
  try {
    const main = await describeInMain(px, py)
    if (main.component) info.component = main.component
    if (!info.testid && main.testid) info.testid = main.testid
  } catch {
    /* MAIN world unavailable — isolated info is still useful */
  }
  return info
}

/** A readable DOM path (tag#id.class:nth) from a few ancestors down. */
function domPath(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  let depth = 0
  while (node && node.nodeType === 1 && depth < 6 && node.tagName !== 'BODY') {
    let part = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(`${part}#${node.id}`)
      break
    }
    const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0]
    if (cls) part += `.${cls}`
    const parent: Element | null = node.parentElement
    if (parent) {
      const sames = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      if (sames.length > 1) part += `:nth-of-type(${sames.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = node.parentElement
    depth++
  }
  return parts.join(' > ')
}

function isFormControl(el: Element): boolean {
  return ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())
}

function isVisible(el: Element): boolean {
  const rect = (el as HTMLElement).getClientRects()
  if (!rect.length) return false
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
}

function selectorFor(el: Element): string {
  if (el.id) return `#${el.id}`
  const parts: string[] = []
  let node: Element | null = el
  let depth = 0
  while (node && depth < 3 && node.nodeType === 1) {
    let part = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(`#${node.id}`)
      break
    }
    const cls = (node.getAttribute('class') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
    if (cls.length) part += '.' + cls.join('.')
    const parent = node.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = node.parentElement
    depth++
  }
  return parts.join(' > ')
}

function labelFor(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria.trim()
  const h = el as HTMLElement
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement
    return (
      input.getAttribute('placeholder') ||
      input.getAttribute('name') ||
      input.getAttribute('type') ||
      'input'
    )
  }
  const text = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ')
  if (text) return trim(text, 60)
  return el.getAttribute('title') || el.getAttribute('name') || ''
}

function roleFor(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  const map: Record<string, string> = {
    a: 'link',
    button: 'button',
    input: `input[${(el as HTMLInputElement).type || 'text'}]`,
    select: 'select',
    textarea: 'textbox',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    form: 'form',
    dialog: 'dialog',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    summary: 'summary',
  }
  return map[tag] ?? tag
}

function stateFor(el: Element): string {
  const flags: string[] = []
  if ((el as HTMLButtonElement).disabled) flags.push('disabled')
  if (el.getAttribute('aria-disabled') === 'true') flags.push('disabled')
  if (el.getAttribute('aria-expanded')) flags.push(`expanded=${el.getAttribute('aria-expanded')}`)
  if (el.getAttribute('aria-hidden') === 'true') flags.push('aria-hidden')
  if ((el as HTMLInputElement).checked) flags.push('checked')
  if ((el as HTMLInputElement).required) flags.push('required')
  return flags.length ? ` [${flags.join(', ')}]` : ''
}

function maskedValue(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase()
  if (tag === 'select') {
    const sel = el as HTMLSelectElement
    return sel.options[sel.selectedIndex]?.text ?? '(selected)'
  }
  const input = el as HTMLInputElement
  const type = (input.type || 'text').toLowerCase()
  if (type === 'checkbox' || type === 'radio') return input.checked ? 'checked' : 'unchecked'
  if (el.hasAttribute('data-clip-unmask') && type !== 'password') {
    return trim(input.value, 40)
  }
  const len = (input.value || '').length
  return len ? `${type} (masked, ${len} chars)` : `${type} (empty)`
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

let seq = 0
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`
}
