// ─────────────────────────────────────────────────────────────────────────
// Isolated-world side of the bridge to the MAIN-world script. Provides:
//   • describeInMain(x, y)  → component name/testid for the element at a point
//   • setRecording(on, t0)  → activate/deactivate the page error hooks
//   • forwards page errors / console.error|warn as CaptureEvents
// ─────────────────────────────────────────────────────────────────────────

import type { CaptureEvent } from '@/shared/types'

type Forward = (e: CaptureEvent) => void

let recording = false
let recStart = 0
let forward: Forward = () => {}
let reqSeq = 0
let idSeq = 0
const pending = new Map<number, (info: MainDescribe) => void>()

export interface MainDescribe {
  component?: string
  tag?: string
  testid?: string
}

export function initBridge(fwd: Forward): void {
  forward = fwd
  window.addEventListener('message', onMessage)
}

function onMessage(e: MessageEvent): void {
  if (e.source !== window) return
  const d = e.data as { __cc?: string; [k: string]: unknown } | undefined
  if (!d || typeof d.__cc !== 'string') return

  if (d.__cc === 'describe-res') {
    const cb = pending.get(d.reqId as number)
    if (cb) {
      pending.delete(d.reqId as number)
      cb((d.info as MainDescribe) ?? {})
    }
  } else if (d.__cc === 'pageerror' && recording) {
    forward({
      id: pid('perr'),
      kind: 'error',
      tMs: Date.now() - recStart,
      exceptionType: d.rejection ? 'UnhandledRejection' : 'Error',
      message: String(d.message ?? 'error'),
      stack: (d.stack as string) || undefined,
      url: (d.url as string) || undefined,
      line: typeof d.line === 'number' ? d.line : undefined,
      column: typeof d.column === 'number' ? d.column : undefined,
      pageHook: true,
    })
  } else if (d.__cc === 'pageconsole' && recording) {
    forward({
      id: pid('pcon'),
      kind: 'console',
      tMs: Date.now() - recStart,
      level: d.level === 'warn' ? 'warn' : 'error',
      text: String(d.text ?? ''),
      stack: (d.stack as string) || undefined,
      pageHook: true,
    })
  }
}

export function setRecording(active: boolean, startEpoch: number): void {
  recording = active
  recStart = startEpoch
  window.postMessage({ __cc: active ? 'record-on' : 'record-off' }, '*')
}

/** Ask the MAIN world for component/testid of the element at a point (best-effort). */
export function describeInMain(x: number, y: number): Promise<MainDescribe> {
  return new Promise((resolve) => {
    const reqId = ++reqSeq
    const timer = setTimeout(() => {
      pending.delete(reqId)
      resolve({})
    }, 90)
    pending.set(reqId, (info) => {
      clearTimeout(timer)
      resolve(info)
    })
    window.postMessage({ __cc: 'describe-req', reqId, x, y }, '*')
  })
}

function pid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(idSeq++).toString(36)}`
}
