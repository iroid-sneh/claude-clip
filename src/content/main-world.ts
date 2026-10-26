// ─────────────────────────────────────────────────────────────────────────
// MAIN-world content script. Runs in the PAGE's JS context (not the isolated
// content-script world), which is the only place we can:
//   • read React/Vue fibers on a DOM node → the component name
//   • see the page's own uncaught errors, unhandled rejections, and
//     console.error/warn with real page stacks
//
// It stays passive until the recorder tells it to activate, and talks to the
// isolated content script purely via window.postMessage (namespaced __cc).
// ─────────────────────────────────────────────────────────────────────────

type Msg = { __cc: string; [k: string]: unknown }

function post(type: string, data: Record<string, unknown>) {
  window.postMessage({ __cc: type, ...data } satisfies Msg, '*')
}

// ── component detection ─────────────────────────────────────────────────────

function reactComponent(start: Element | null): string | undefined {
  let node: Element | null = start
  for (let up = 0; up < 4 && node; up++, node = node.parentElement) {
    const key = Object.keys(node).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    )
    if (!key) continue
    let fiber: any = (node as any)[key]
    let depth = 0
    while (fiber && depth++ < 30) {
      const t = fiber.type
      const name =
        typeof t === 'function'
          ? t.displayName || t.name
          : t && typeof t === 'object'
            ? t.displayName || t.render?.displayName || t.render?.name
            : null
      if (name && /^[A-Z]/.test(name) && name !== 'Fragment') return name
      fiber = fiber.return
    }
  }
  return undefined
}

function vueComponent(start: Element | null): string | undefined {
  let node: any = start
  for (let up = 0; up < 4 && node; up++, node = node.parentElement) {
    const vc = node.__vueParentComponent || node.__vue__
    const name = vc?.type?.name || vc?.type?.__name || vc?.$options?.name
    if (name) return name
  }
  return undefined
}

function describe(x: number, y: number) {
  const el = document.elementFromPoint(x, y)
  if (!el) return {}
  return {
    component: reactComponent(el) ?? vueComponent(el),
    tag: el.tagName.toLowerCase(),
    testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
  }
}

// ── error / console hooks (activated only while recording) ──────────────────

let active = false
const origError = console.error
const origWarn = console.warn

function fmtArg(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }
  return String(a)
}

const onError = (e: ErrorEvent) => {
  if (!active) return
  post('pageerror', {
    message: e.message,
    stack: (e.error && e.error.stack) || undefined,
    url: e.filename,
    line: e.lineno,
    column: e.colno,
  })
}

const onRejection = (e: PromiseRejectionEvent) => {
  if (!active) return
  const r: any = e.reason
  post('pageerror', {
    message: (r && r.message) || String(r),
    stack: (r && r.stack) || undefined,
    rejection: true,
  })
}

function activate() {
  if (active) return
  active = true
  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection, true)
  console.error = (...args: unknown[]) => {
    post('pageconsole', { level: 'error', text: args.map(fmtArg).join(' '), stack: new Error().stack })
    return origError.apply(console, args as [])
  }
  console.warn = (...args: unknown[]) => {
    post('pageconsole', { level: 'warn', text: args.map(fmtArg).join(' ') })
    return origWarn.apply(console, args as [])
  }
}

function deactivate() {
  if (!active) return
  active = false
  window.removeEventListener('error', onError, true)
  window.removeEventListener('unhandledrejection', onRejection, true)
  console.error = origError
  console.warn = origWarn
}

// ── request/response bridge with the isolated content script ────────────────

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return
  const d = e.data as Msg | undefined
  if (!d || typeof d.__cc !== 'string') return
  switch (d.__cc) {
    case 'describe-req':
      post('describe-res', { reqId: d.reqId, info: describe(Number(d.x), Number(d.y)) })
      break
    case 'record-on':
      activate()
      break
    case 'record-off':
      deactivate()
      break
  }
})
