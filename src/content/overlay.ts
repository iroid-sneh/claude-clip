// ─────────────────────────────────────────────────────────────────────────
// The on-page annotation overlay — an Excalidraw-style floating toolbar plus
// a full-viewport canvas. Lives only while a recording is active.
//
// Interaction model (matches pro bug tools): the default tool is "cursor",
// which lets all pointer events pass through to the page so the user can
// reproduce the bug. Selecting a drawing tool captures the canvas until they
// switch back. Every completed stroke is sent to the background as an
// Annotation with a record-relative timestamp.
// ─────────────────────────────────────────────────────────────────────────

import type { RoughCanvas } from 'roughjs/bin/canvas'
import type { Annotation, ToolKind } from '@/shared/types'
import { makeRough, renderAnnotation, renderLive, type StrokeStyle } from './draw-engine'
import { toolbarMarkup, TOOLBAR_CSS } from './toolbar'
import { describeElement } from './interactions'

type ActiveTool = ToolKind | 'cursor'

const COLORS = ['#ff453a', '#ffd60a', '#32d74b', '#0a84ff', '#d97757', '#1c1c1e']
const WIDTHS = [2, 4, 7]
const FREEHAND_TOOLS: ToolKind[] = ['pen', 'highlighter', 'eraser']

export class Overlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private rc: RoughCanvas
  private host: HTMLDivElement
  private root: ShadowRoot
  private startEpoch = 0

  private tool: ActiveTool = 'cursor'
  private color = COLORS[0]
  private width = WIDTHS[1]

  private annotations: Annotation[] = []
  private drawing = false
  private livePoints: number[] = []
  private liveSeed = 0
  private raf = 0
  private visible = false
  private editor?: HTMLInputElement
  /** Ids whose send should be suppressed (undone before enrichment finished). */
  private cancelled = new Set<string>()
  /** Screen bounds of each mark's badge + note pill, rebuilt every frame, so a
   * click can be hit-tested to "edit this note" instead of drawing a new mark. */
  private labelBounds = new Map<string, LabelHit>()

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.setAttribute('data-claude-clip', 'canvas')
    Object.assign(this.canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      zIndex: '2147483646',
      pointerEvents: 'none',
      cursor: 'crosshair',
      // Prevent the browser from scrolling/zooming the page while drawing with
      // touch or a stylus (essential for mobile / device-emulation).
      touchAction: 'none',
    } satisfies Partial<CSSStyleDeclaration>)
    this.ctx = this.canvas.getContext('2d')!
    this.rc = makeRough(this.canvas)

    this.host = document.createElement('div')
    this.host.setAttribute('data-claude-clip', 'toolbar-host')
    this.root = this.host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = TOOLBAR_CSS
    const bar = document.createElement('div')
    bar.innerHTML = toolbarMarkup(COLORS, WIDTHS)
    this.root.append(style, bar)

    this.bindToolbar()
    this.onPointerDown = this.onPointerDown.bind(this)
    this.onPointerMove = this.onPointerMove.bind(this)
    this.onPointerUp = this.onPointerUp.bind(this)
    this.resize = this.resize.bind(this)
  }

  show(startEpoch: number): void {
    if (this.visible) return
    this.visible = true
    this.startEpoch = startEpoch || Date.now()
    document.documentElement.append(this.canvas, this.host)
    this.resize()
    window.addEventListener('resize', this.resize)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.loop()
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    window.removeEventListener('resize', this.resize)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    cancelAnimationFrame(this.raf)
    this.editor?.remove()
    this.editor = undefined
    this.canvas.remove()
    this.host.remove()
    this.annotations = []
    this.cancelled.clear()
  }

  // ── toolbar wiring ──────────────────────────────────────────────────────

  private bindToolbar(): void {
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
      if (!el) return
      const act = el.dataset.act!
      const val = el.dataset.val

      if (act === 'tool') this.setTool(val as ActiveTool)
      else if (act === 'color') this.setColor(val!)
      else if (act === 'width') this.setWidth(Number(val))
      else if (act === 'undo') this.undo()
      else if (act === 'clear') this.clearAll()
    })
    this.syncToolbar()
  }

  private setTool(tool: ActiveTool): void {
    this.tool = tool
    this.canvas.style.pointerEvents = tool === 'cursor' ? 'none' : 'auto'
    this.syncToolbar()
  }

  private setColor(c: string): void {
    this.color = c
    this.syncToolbar()
  }

  private setWidth(w: number): void {
    this.width = w
    this.syncToolbar()
  }

  private syncToolbar(): void {
    this.root.querySelectorAll<HTMLElement>('[data-act="tool"]').forEach((el) => {
      el.classList.toggle('active', el.dataset.val === this.tool)
    })
    this.root.querySelectorAll<HTMLElement>('[data-act="color"]').forEach((el) => {
      el.classList.toggle('active', el.dataset.val === this.color)
    })
    this.root.querySelectorAll<HTMLElement>('[data-act="width"]').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.val) === this.width)
    })
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  private style(): StrokeStyle {
    return { tool: this.tool as ToolKind, color: this.color, strokeWidth: this.width }
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.tool === 'cursor') return
    e.preventDefault()

    // Click landed on an existing mark's badge/note? Edit that note instead of
    // starting a new mark. (Any drawing tool active makes marks clickable.)
    const hit = this.hitTestLabel(e.clientX, e.clientY)
    if (hit) {
      this.editAnnotation(hit)
      return
    }

    // Text tool: click to drop a standalone note pin (no dragging).
    if (this.tool === 'text') {
      const x = e.clientX
      const y = e.clientY
      this.openNoteEditor(x, y, (note) => {
        if (!note) return
        const annotation = this.makeAnnotation('text', [x, y, x + 1, y + 1])
        annotation.note = note
        void this.enrichAndSend(annotation)
      })
      return
    }

    this.drawing = true
    this.livePoints = [e.clientX, e.clientY]
    this.liveSeed = (Math.random() * 2 ** 31) | 0
    this.canvas.setPointerCapture(e.pointerId)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drawing) return
    const freehand = FREEHAND_TOOLS.includes(this.tool as ToolKind)
    if (freehand) {
      this.livePoints.push(e.clientX, e.clientY)
    } else {
      // shapes only need first + current corner
      this.livePoints[2] = e.clientX
      this.livePoints[3] = e.clientY
      this.livePoints.length = 4
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drawing) return
    this.drawing = false
    this.canvas.releasePointerCapture(e.pointerId)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)

    if (this.livePoints.length >= 4) {
      const tool = this.tool as ToolKind
      const annotation = this.makeAnnotation(tool, [...this.livePoints]) // rendered immediately

      if (tool !== 'eraser') {
        // Any mark (square, circle, arrow, pen…) can get a note. Prompt at its
        // anchor, then snapshot the region so the consumer can SEE it.
        const [ax, ay] = targetPoint(tool, annotation.points)
        this.openNoteEditor(ax, ay, async (note) => {
          if (note) annotation.note = note
          annotation.image = await this.captureRegion(annotation)
          void this.enrichAndSend(annotation)
        })
      } else {
        void this.enrichAndSend(annotation)
      }
    }
    this.livePoints = []
  }

  /** Screenshot the tab and crop to the mark + its note so Claude can see it. */
  private async captureRegion(a: Annotation): Promise<string | undefined> {
    // Let the note badge/pill render before we grab the frame.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    let full: string | undefined
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE' })) as {
        dataUrl?: string
      }
      full = res?.dataUrl
    } catch {
      return undefined
    }
    if (!full) return undefined

    // Bounding box of the shape, expanded to include the note pill + margin.
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < a.points.length - 1; i += 2) {
      xs.push(a.points[i])
      ys.push(a.points[i + 1])
    }
    const [ax, ay] = targetPoint(a.type, a.points)
    const pad = 28
    let minX = Math.min(...xs) - pad
    let minY = Math.min(...ys) - pad
    let maxX = Math.max(...xs) + pad
    let maxY = Math.max(...ys) + pad
    if (a.note) {
      maxX = Math.max(maxX, ax + 260)
      minY = Math.min(minY, ay - 44)
      maxY = Math.max(maxY, ay + 44)
    }
    const vw = window.innerWidth
    const vh = window.innerHeight
    minX = Math.max(0, minX)
    minY = Math.max(0, minY)
    maxX = Math.min(vw, maxX)
    maxY = Math.min(vh, maxY)
    return cropDataUrl(full, minX, minY, maxX - minX, maxY - minY, window.devicePixelRatio || 1)
  }

  /** Create + register an annotation. The number is its position, so an undo
   * frees the number for the next mark. */
  private makeAnnotation(type: ToolKind, points: number[]): Annotation {
    const annotation: Annotation = {
      id: `ann_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`,
      tMs: Date.now() - this.startEpoch,
      type,
      points,
      color: this.color,
      strokeWidth: this.width,
      index: this.annotations.length + 1,
      url: location.href,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }
    this.annotations.push(annotation)
    return annotation
  }

  /**
   * Floating inline text input anchored at (x,y) to capture (or edit) a mark's
   * note. `initial` prefills it for editing; the callback's `saved` flag is
   * false when the user pressed Escape, so an edit can be cancelled without
   * wiping the existing note.
   */
  private openNoteEditor(
    x: number,
    y: number,
    onCommit: (note: string, saved: boolean) => void,
    initial = '',
  ): void {
    safeRemove(this.editor)
    const input = document.createElement('input')
    input.type = 'text'
    input.setAttribute('data-claude-clip', 'note-input')
    input.placeholder = 'Type a note, Enter to save…'
    input.setAttribute('spellcheck', 'false')
    input.value = initial
    Object.assign(input.style, {
      position: 'fixed',
      left: `${Math.min(x, window.innerWidth - 240)}px`,
      top: `${Math.min(y + 8, window.innerHeight - 44)}px`,
      zIndex: '2147483647',
      width: '230px',
      height: '34px',
      padding: '0 12px',
      borderRadius: '9px',
      border: '1px solid rgba(217,119,87,0.6)',
      background: 'rgba(26,25,21,0.96)',
      color: '#f4efe6',
      font: '500 13px -apple-system, Segoe UI, system-ui, sans-serif',
      boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
      outline: 'none',
      pointerEvents: 'auto',
    } satisfies Partial<CSSStyleDeclaration>)
    document.documentElement.appendChild(input)
    this.editor = input
    // Focus after the current pointer event settles; select any prefilled text
    // so editing overwrites cleanly.
    setTimeout(() => {
      input.focus()
      if (initial) input.select()
    }, 0)

    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      const value = save ? input.value.trim() : ''
      // Idempotent: a page blur handler may have already detached/moved the
      // node — removing it again would throw NotFoundError.
      safeRemove(input)
      if (this.editor === input) this.editor = undefined
      onCommit(value, save)
    }
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation() // keep keystrokes out of the page
      if (ev.key === 'Enter') finish(true)
      else if (ev.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }

  /** Attach the element under the mark (+ its outerHTML and key styles). */
  private async enrichAndSend(annotation: Annotation): Promise<void> {
    const [px, py] = targetPoint(annotation.type, annotation.points)
    const el = elementUnder(px, py)
    if (el) {
      annotation.target = await describeElement(el, px, py)
      annotation.outerHTML = trimHtml((el as HTMLElement).outerHTML)
      annotation.styles = keyStyles(el)
    }
    // If it was undone while we were enriching (async), don't send it.
    if (this.cancelled.has(annotation.id)) return
    chrome.runtime.sendMessage({ type: 'ADD_ANNOTATION', annotation }).catch(() => {})
  }

  private undo(): void {
    const removed = this.annotations.pop()
    if (!removed) return
    // Suppress a not-yet-sent send, and remove it from the session if sent.
    this.cancelled.add(removed.id)
    chrome.runtime.sendMessage({ type: 'REMOVE_ANNOTATION', id: removed.id }).catch(() => {})
  }

  private clearAll(): void {
    for (const a of this.annotations) this.cancelled.add(a.id)
    this.annotations = []
    chrome.runtime.sendMessage({ type: 'CLEAR_ANNOTATIONS' }).catch(() => {})
  }

  /** Return the annotation whose badge or note pill sits under (x,y), if any. */
  private hitTestLabel(x: number, y: number): Annotation | undefined {
    // Topmost first: later marks render on top, so search in reverse.
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const a = this.annotations[i]
      const b = this.labelBounds.get(a.id)
      if (!b) continue
      const inBadge = Math.hypot(x - b.cx, y - b.cy) <= b.r + 3
      const inPill =
        b.pill != null &&
        x >= b.pill.x &&
        x <= b.pill.x + b.pill.w &&
        y >= b.pill.y &&
        y <= b.pill.y + b.pill.h
      if (inBadge || inPill) return a
    }
    return undefined
  }

  /** Open the editor on an existing mark to change (or clear) its note. */
  private editAnnotation(a: Annotation): void {
    const [ax, ay] = targetPoint(a.type, a.points)
    this.openNoteEditor(
      ax,
      ay,
      async (note, saved) => {
        if (!saved) return // Escape → leave the note untouched
        a.note = note || undefined
        // The pill changed size/content — refresh the region crop to match.
        a.image = await this.captureRegion(a)
        if (this.cancelled.has(a.id)) return
        chrome.runtime.sendMessage({ type: 'ADD_ANNOTATION', annotation: a }).catch(() => {})
      },
      a.note ?? '',
    )
  }

  // ── render loop ─────────────────────────────────────────────────────────

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.floor(window.innerWidth * dpr)
    this.canvas.height = Math.floor(window.innerHeight * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private loop(): void {
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    for (const a of this.annotations) renderAnnotation(this.ctx, this.rc, a)
    this.labelBounds.clear() // rebuilt below so hit-testing stays in sync
    for (const a of this.annotations) this.renderMarkLabel(a) // badges + notes on top
    if (this.drawing && this.livePoints.length >= 2) {
      renderLive(this.ctx, this.rc, this.style(), this.livePoints, this.liveSeed)
    }
    this.raf = requestAnimationFrame(() => this.loop())
  }

  /** Draw the mark's number badge and its note text, near the mark. */
  private renderMarkLabel(a: Annotation): void {
    const ctx = this.ctx
    const [ax, ay] = targetPoint(a.type, a.points)
    ctx.save()

    // number badge
    const r = 11
    ctx.beginPath()
    ctx.arc(ax, ay, r, 0, Math.PI * 2)
    ctx.fillStyle = a.color
    ctx.fill()
    ctx.fillStyle = '#1a0f0a'
    ctx.font = '700 12px -apple-system, Segoe UI, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(a.index ?? ''), ax, ay + 0.5)

    const hit: LabelHit = { cx: ax, cy: ay, r }

    // note text pill
    if (a.note) {
      const pad = 7
      const lh = 16
      const maxW = 220
      ctx.font = '500 13px -apple-system, Segoe UI, system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const lines = wrapText(ctx, `${a.index}. ${a.note}`, maxW)
      const boxW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + pad * 2
      const boxH = lines.length * lh + pad * 2
      let bx = ax + r + 6
      let by = ay - boxH / 2
      bx = Math.max(4, Math.min(bx, window.innerWidth - boxW - 4))
      by = Math.max(4, Math.min(by, window.innerHeight - boxH - 4))
      roundRect(ctx, bx, by, boxW, boxH, 8)
      ctx.fillStyle = 'rgba(26,25,21,0.94)'
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = a.color
      ctx.stroke()
      ctx.fillStyle = '#f4efe6'
      lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + i * lh))
      hit.pill = { x: bx, y: by, w: boxW, h: boxH }
    }
    if (a.id) this.labelBounds.set(a.id, hit)
    ctx.restore()
  }
}

/** Clickable screen bounds of a mark's badge (circle) and optional note pill. */
interface LabelHit {
  cx: number
  cy: number
  r: number
  pill?: { x: number; y: number; w: number; h: number }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line)
      line = w
    } else {
      line = test
    }
    if (lines.length >= 4) break
  }
  if (line && lines.length < 4) lines.push(line)
  if (lines.length >= 4) lines[3] = lines[3].replace(/.{0,3}$/, '…')
  return lines
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** The point a mark refers to: an arrow's tip, a shape's center, a stroke's end. */
function targetPoint(type: ToolKind, pts: number[]): [number, number] {
  const x0 = pts[0]
  const y0 = pts[1]
  const x1 = pts[pts.length - 2]
  const y1 = pts[pts.length - 1]
  if (type === 'rectangle' || type === 'ellipse') return [(x0 + x1) / 2, (y0 + y1) / 2]
  return [x1, y1] // arrow tip / end of pen/highlighter stroke
}

/** Topmost page element at a point, ignoring our own overlay. */
function elementUnder(x: number, y: number): Element | null {
  const stack = document.elementsFromPoint(x, y)
  for (const el of stack) {
    if (!el.closest('[data-claude-clip]')) return el
  }
  return null
}

const STYLE_KEYS = [
  'display',
  'position',
  'overflow',
  'text-overflow',
  'white-space',
  'width',
  'max-width',
  'height',
  'font-size',
  'line-height',
  'color',
  'background-color',
  'z-index',
  'visibility',
  'opacity',
  'transform',
]

function keyStyles(el: Element): Record<string, string> {
  const cs = getComputedStyle(el)
  const out: Record<string, string> = {}
  for (const k of STYLE_KEYS) {
    const v = cs.getPropertyValue(k)
    if (v && v !== 'normal' && v !== 'none' && v !== 'auto') out[k] = v.trim()
  }
  return out
}

function trimHtml(html: string): string {
  return html.length > 1500 ? html.slice(0, 1500) + '…' : html
}

/** Remove a node without throwing if the page already detached/moved it. */
function safeRemove(node: Element | null | undefined): void {
  try {
    node?.parentNode?.removeChild(node)
  } catch {
    /* already gone */
  }
}

/** Crop a full-viewport screenshot (device px) to a CSS-px region → JPEG. */
function cropDataUrl(
  dataUrl: string,
  x: number,
  y: number,
  w: number,
  h: number,
  dpr: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (w <= 4 || h <= 4) return resolve(undefined)
    const img = new Image()
    img.onload = () => {
      // Cap output width for a compact, legible image.
      const scale = Math.min(1, 1000 / (w * dpr))
      const cw = Math.round(w * dpr * scale)
      const ch = Math.round(h * dpr * scale)
      const canvas = document.createElement('canvas')
      canvas.width = cw
      canvas.height = ch
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(undefined)
      ctx.drawImage(img, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, cw, ch)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => resolve(undefined)
    img.src = dataUrl
  })
}
