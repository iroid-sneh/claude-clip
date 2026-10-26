// ─────────────────────────────────────────────────────────────────────────
// The CDP capture engine — the differentiating core of Claude Clip.
//
// Attaches chrome.debugger (Chrome DevTools Protocol) to a tab and subscribes
// to the four highest-signal event families (see PLAN.md §5, tier 🟢):
//   • Network.*                — requests/responses WITH bodies, timing, CORS
//   • Runtime.consoleAPICalled — every console.* with structured args + stack
//   • Runtime.exceptionThrown  — uncaught exceptions & unhandled rejections
//   • Log.entryAdded           — browser-internal CORS/CSP/deprecation logs
//
// This is the only route in MV3 to real response bodies + browser logs, which
// is how Claude Clip out-captures SDK-based tools (Sentry/LogRocket/OpenReplay).
// ─────────────────────────────────────────────────────────────────────────

import type {
  BrowserLogEvent,
  ConsoleEvent,
  ConsoleLevel,
  ErrorEvent,
  NetworkEvent,
  StackFrame,
} from '@/shared/types'

const PROTOCOL_VERSION = '1.3'
const MAX_BODY_BYTES = 512 * 1024 // normal response bodies: cap + truncate
const MAX_ERROR_BODY_BYTES = 4 * 1024 * 1024 // failed/malformed: keep in full (safety cap)

let seq = 0
const nextId = (prefix: string) => `${prefix}_${(seq++).toString(36)}`

type EventSink = (e: ConsoleEvent | ErrorEvent | BrowserLogEvent | NetworkEvent) => void

interface PendingRequest {
  event: NetworkEvent
  sentMonotonic: number
}

/**
 * Manages a single debugger attachment and translates raw CDP events into
 * Claude Clip's normalized capture model. One instance per active recording.
 */
export class CdpSession {
  private target: chrome.debugger.Debuggee
  private startEpoch: number
  private sink: EventSink
  private pending = new Map<string, PendingRequest>()
  // Requests fired by OTHER installed extensions (axe DevTools, React DevTools,
  // Grammarly, ad blockers…). We drop them and remember their ids so the
  // browser logs they spawn (CORS/failed-resource) can be dropped too.
  private ignoredRequestIds = new Set<string>()
  private detached = false
  private boundOnEvent: (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ) => void
  private boundOnDetach: (source: chrome.debugger.Debuggee, reason: string) => void
  onUnexpectedDetach?: (reason: string) => void

  constructor(tabId: number, startEpoch: number, sink: EventSink) {
    this.target = { tabId }
    this.startEpoch = startEpoch
    this.sink = sink
    this.boundOnEvent = this.handleEvent.bind(this)
    this.boundOnDetach = this.handleDetach.bind(this)
  }

  private tMs(): number {
    return Date.now() - this.startEpoch
  }

  /** Attach and enable the capture domains. Throws if the tab can't be attached. */
  async attach(): Promise<void> {
    await chrome.debugger.attach(this.target, PROTOCOL_VERSION)
    chrome.debugger.onEvent.addListener(this.boundOnEvent)
    chrome.debugger.onDetach.addListener(this.boundOnDetach)

    // Buffer generously so large response bodies survive until we read them.
    await this.send('Network.enable', {
      maxResourceBufferSize: 100 * 1024 * 1024,
      maxTotalBufferSize: 200 * 1024 * 1024,
    })
    await this.send('Runtime.enable')
    await this.send('Log.enable')
    // Page domain gives us lifecycle + a screenshot source for keyframes later.
    await this.send('Page.enable')
  }

  async detach(): Promise<void> {
    if (this.detached) return
    this.detached = true
    chrome.debugger.onEvent.removeListener(this.boundOnEvent)
    chrome.debugger.onDetach.removeListener(this.boundOnDetach)
    try {
      await chrome.debugger.detach(this.target)
    } catch {
      // Tab may already be gone — ignore.
    }
  }

  private send(method: string, params?: object): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(this.target, method, params, (result) => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve(result)
      })
    })
  }

  private handleDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (source.tabId !== this.target.tabId || this.detached) return
    this.detached = true
    this.onUnexpectedDetach?.(reason)
  }

  private handleEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: any,
  ): void {
    if (source.tabId !== this.target.tabId) return
    switch (method) {
      case 'Network.requestWillBeSent':
        return this.onRequestWillBeSent(params)
      case 'Network.responseReceived':
        return this.onResponseReceived(params)
      case 'Network.loadingFinished':
        return void this.onLoadingFinished(params)
      case 'Network.loadingFailed':
        return this.onLoadingFailed(params)
      case 'Runtime.consoleAPICalled':
        return this.onConsoleApiCalled(params)
      case 'Runtime.exceptionThrown':
        return this.onExceptionThrown(params)
      case 'Log.entryAdded':
        return this.onLogEntryAdded(params)
    }
  }

  // ── Network ────────────────────────────────────────────────────────────

  private onRequestWillBeSent(p: any): void {
    // Ignore requests that aren't part of the application — extension tooling
    // (our own overlay, axe, highlighters) and browser-internal schemes add
    // noise that could mislead the consumer.
    if (isIgnorableUrl(p.request?.url ?? '')) return

    // Requests fired by ANOTHER installed extension (its content script is the
    // initiator) go to a normal https URL, so the scheme check above misses
    // them — e.g. axe DevTools' GET axe.deque.com, which once became a false
    // primary_suspect. Drop them, and remember the id so the CORS/failed-resource
    // browser logs they trigger get dropped too.
    if (isExtensionInitiated(p.initiator)) {
      this.ignoredRequestIds.add(p.requestId)
      return
    }

    // Fold redirects into the same logical event by keying on requestId.
    const existing = this.pending.get(p.requestId)
    const event: NetworkEvent = existing?.event ?? {
      id: nextId('net'),
      kind: 'network',
      requestId: p.requestId,
      tMs: this.tMs(),
      method: p.request?.method ?? 'GET',
      url: p.request?.url ?? '',
    }
    event.method = p.request?.method ?? event.method
    event.url = p.request?.url ?? event.url
    event.requestHeaders = p.request?.headers ?? event.requestHeaders
    if (p.request?.postData) event.requestBody = truncate(p.request.postData)
    if (p.initiator?.url) {
      event.initiator = p.initiator.stack?.callFrames?.[0]
        ? frameLabel(p.initiator.stack.callFrames[0])
        : p.initiator.url
    }
    this.pending.set(p.requestId, {
      event,
      sentMonotonic: p.timestamp ?? 0,
    })
  }

  private onResponseReceived(p: any): void {
    const rec = this.pending.get(p.requestId)
    if (!rec) return
    const r = p.response ?? {}
    rec.event.status = r.status
    rec.event.statusText = r.statusText
    rec.event.mimeType = r.mimeType
    rec.event.resourceType = p.type
    rec.event.responseHeaders = r.headers
    rec.event.fromCache = !!r.fromDiskCache
    rec.event.remoteIP = r.remoteIPAddress
    if (r.timing) {
      // receiveHeadersEnd is ms from requestTime → approximate TTFB.
      rec.event.ttfbMs = Math.round(r.timing.receiveHeadersEnd ?? 0)
    }
  }

  private async onLoadingFinished(p: any): Promise<void> {
    const rec = this.pending.get(p.requestId)
    if (!rec) return
    rec.event.durationMs = this.tMs() - rec.event.tMs
    rec.event.sizeBytes = p.encodedDataLength
    await this.attachResponseBody(rec.event, p.requestId)
    this.emit(rec.event)
    this.pending.delete(p.requestId)
  }

  private onLoadingFailed(p: any): void {
    const rec = this.pending.get(p.requestId)
    if (!rec) return
    rec.event.failed = true
    rec.event.errorText = p.errorText
    rec.event.blockedReason = p.blockedReason
    rec.event.corsError = p.corsErrorStatus?.corsError
    rec.event.durationMs = this.tMs() - rec.event.tMs
    this.emit(rec.event)
    this.pending.delete(p.requestId)
  }

  private async attachResponseBody(event: NetworkEvent, requestId: string): Promise<void> {
    // Skip bodies for media/binary — noisy and often unreadable to an LLM.
    const mime = event.mimeType ?? ''
    if (/^(image|video|audio|font)\//.test(mime)) return
    try {
      const res = await this.send('Network.getResponseBody', { requestId })
      if (res?.body == null) return
      const body = res.base64Encoded ? '[binary response omitted]' : String(res.body)

      // A JSON response that doesn't parse is a real bug — keep the raw body so
      // the consumer can point at the exact broken part.
      const looksJson = /json/i.test(mime) || /^\s*[[{]/.test(body)
      if (looksJson) {
        try {
          JSON.parse(body)
        } catch {
          event.malformed = true
        }
      }

      // Keep failed / error / malformed bodies in full (up to a hard safety
      // cap); only truncate ordinary successful responses.
      const keepFull = event.failed || (event.status ?? 0) >= 400 || event.malformed
      const cap = keepFull ? MAX_ERROR_BODY_BYTES : MAX_BODY_BYTES
      if (body.length > cap) {
        event.responseBody = body.slice(0, cap) + '\n…[truncated]'
        event.responseBodyTruncated = true
      } else {
        event.responseBody = body
      }
    } catch {
      // getResponseBody is unreliable for streamed/large bodies (issue #44).
      // A content-script fetch/XHR fallback fills this in a later phase.
    }
  }

  // ── Console / exceptions ─────────────────────────────────────────────────

  private onConsoleApiCalled(p: any): void {
    const args: string[] = (p.args ?? []).map(remoteObjectToText)
    const text = args.join(' ')
    const frame = p.stackTrace?.callFrames?.[0]
    const event: ConsoleEvent = {
      id: nextId('con'),
      kind: 'console',
      tMs: this.tMs(),
      level: normalizeConsoleLevel(p.type),
      text,
      args,
      stack: stackToText(p.stackTrace),
      stackFrames: stackToFrames(p.stackTrace),
      url: frame?.url,
      line: frame?.lineNumber != null ? frame.lineNumber + 1 : undefined,
    }
    this.emit(event)
  }

  private onExceptionThrown(p: any): void {
    const d = p.exceptionDetails ?? {}
    // Ignore exceptions thrown by extension code (this recorder or others) —
    // they aren't the app's bug and must not become the primary suspect.
    const originUrl = d.url || d.stackTrace?.callFrames?.[0]?.url || ''
    if (/^(chrome-extension|moz-extension):\/\//i.test(originUrl)) return
    const ex = d.exception
    const message =
      d.exception?.description ??
      d.text ??
      remoteObjectToText(ex) ??
      'Uncaught exception'
    const event: ErrorEvent = {
      id: nextId('err'),
      kind: 'error',
      tMs: this.tMs(),
      exceptionType: ex?.className ?? 'Error',
      message: String(message).split('\n')[0],
      stack: stackToText(d.stackTrace) ?? String(message),
      stackFrames: stackToFrames(d.stackTrace),
      url: d.url,
      line: d.lineNumber != null ? d.lineNumber + 1 : undefined,
      column: d.columnNumber,
    }
    this.emit(event)
  }

  private onLogEntryAdded(p: any): void {
    const e = p.entry ?? {}
    // Skip logs emitted by another extension's script (url is chrome-extension://,
    // e.g. axe's inspector.js "unload not allowed" violation) or tied to a
    // request we already dropped as extension-initiated (its CORS / failed-load
    // browser logs). Otherwise a third-party extension pollutes errors[].
    if (isExtensionUrl(e.url)) return
    if (e.networkRequestId && this.ignoredRequestIds.has(e.networkRequestId)) return
    const event: BrowserLogEvent = {
      id: nextId('log'),
      kind: 'log',
      tMs: this.tMs(),
      source: e.source ?? 'other',
      level: e.level ?? 'info',
      text: e.text ?? '',
      url: e.url,
      category: e.category,
      networkRequestId: e.networkRequestId,
    }
    this.emit(event)
  }

  private emit(e: ConsoleEvent | ErrorEvent | BrowserLogEvent | NetworkEvent): void {
    if (this.detached) return
    this.sink(e)
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function truncate(s: string): string {
  return s.length > MAX_BODY_BYTES ? s.slice(0, MAX_BODY_BYTES) + '…[truncated]' : s
}

/** Requests we never want in the capture — extensions, browser-internal, and
 * inline data:/blob: pseudo-requests (not real network calls; their payloads
 * can be hundreds of KB and would dominate the bundle). */
function isIgnorableUrl(url: string): boolean {
  return /^(chrome-extension|moz-extension|chrome|edge|devtools|about|data|blob):/i.test(url)
}

const EXTENSION_URL_RE = /^(chrome-extension|moz-extension):\/\//i

function isExtensionUrl(url?: string): boolean {
  return !!url && EXTENSION_URL_RE.test(url)
}

/** True when a network request was fired by an installed extension's script —
 * its initiator url, or any frame in its (async) initiator stack, is an
 * extension origin. These aren't the app's traffic and must not be captured. */
function isExtensionInitiated(initiator: any): boolean {
  if (!initiator) return false
  if (isExtensionUrl(initiator.url)) return true
  let stack = initiator.stack
  let guard = 0
  while (stack && guard++ < 6) {
    if (stack.callFrames?.some((f: any) => isExtensionUrl(f?.url))) return true
    stack = stack.parent
  }
  return false
}

function normalizeConsoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'warning':
      return 'warn'
    case 'error':
    case 'assert':
      return 'error'
    case 'debug':
      return 'debug'
    case 'info':
      return 'info'
    case 'trace':
      return 'trace'
    default:
      return 'log'
  }
}

function frameLabel(f: any): string {
  // Fuller than a bare filename: keep the full URL + line:col so the consumer
  // can locate the exact site.
  const fn = f.functionName || '(anonymous)'
  const url = f.url || '<anonymous>'
  return `${fn} (${url}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1})`
}

function stackToText(stack: any): string | undefined {
  const frames = stack?.callFrames
  if (!frames?.length) return undefined
  const lines = frames.slice(0, 30).map((f: any) => `  at ${frameLabel(f)}`)
  // Include async parent chains — often where the real caller lives.
  let parent = stack.parent
  let guard = 0
  while (parent?.callFrames?.length && guard++ < 4) {
    lines.push(`  — async —`)
    lines.push(...parent.callFrames.slice(0, 10).map((f: any) => `  at ${frameLabel(f)}`))
    parent = parent.parent
  }
  return lines.join('\n')
}

function stackToFrames(stack: any): StackFrame[] | undefined {
  const frames = stack?.callFrames
  if (!frames?.length) return undefined
  return frames.slice(0, 30).map((f: any) => ({
    function: f.functionName || '(anonymous)',
    url: f.url || undefined,
    line: f.lineNumber != null ? f.lineNumber + 1 : undefined,
    column: f.columnNumber != null ? f.columnNumber + 1 : undefined,
  }))
}

/** Best-effort readable text for a CDP RemoteObject (keeps objects inspectable). */
function remoteObjectToText(o: any): string {
  if (o == null) return ''
  if (o.type === 'string') return o.value ?? ''
  if (o.type === 'number' || o.type === 'boolean') return String(o.value)
  if (o.type === 'undefined') return 'undefined'
  if (o.subtype === 'null') return 'null'
  if (o.unserializableValue) return String(o.unserializableValue)
  if (o.value !== undefined) {
    try {
      return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value)
    } catch {
      return String(o.value)
    }
  }
  if (o.preview) return previewToText(o.preview)
  return o.description ?? o.className ?? '[object]'
}

function previewToText(preview: any): string {
  if (!preview?.properties) return preview?.description ?? '[object]'
  const parts = preview.properties
    .slice(0, 8)
    .map((p: any) => `${p.name}: ${p.value ?? p.type}`)
  const body = parts.join(', ')
  return preview.subtype === 'array' ? `[${body}]` : `{${body}}`
}
