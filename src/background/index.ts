// ─────────────────────────────────────────────────────────────────────────
// Service worker — the recording state machine + message router.
//
// Owns one CdpSession at a time, buffers events into a Session, persists to
// IndexedDB continuously (survives SW eviction), and answers popup RPC.
// ─────────────────────────────────────────────────────────────────────────

import { CdpSession } from './cdp'
import {
  deleteSession,
  getActiveSessionId,
  listSessions,
  loadFrames,
  loadSession,
  saveSession,
  setActiveSessionId,
} from './store'
import { buildAgentContext } from './bundle'
import { pickKeyframes } from './keyframes'
import type {
  AckResponse,
  ExportResponse,
  Msg,
  StateResponse,
} from '@/shared/messages'
import type {
  Annotation,
  CaptureCounts,
  CaptureEvent,
  DomSnapshotEvent,
  EnvironmentMeta,
  InteractionEvent,
  Session,
  SessionSummary,
  TranscriptSegment,
} from '@/shared/types'
import type { HistoryResponse, SnapshotResponse } from '@/shared/messages'

// In-memory live state. Rehydrated from IndexedDB if the worker was evicted.
let cdp: CdpSession | null = null
let live: Session | null = null
let persistTimer: ReturnType<typeof setInterval> | null = null
// Whether a live content script acknowledged the overlay/tracker for this
// recording (false = the page needs a reload to enable drawing + actions).
let overlayReady = false

const badge = {
  recording() {
    chrome.action.setBadgeText({ text: 'REC' })
    chrome.action.setBadgeBackgroundColor({ color: '#ff453a' })
  },
  clear() {
    chrome.action.setBadgeText({ text: '' })
  },
}

// ── offscreen document (hosts MediaRecorder) ─────────────────────────────

const OFFSCREEN_PATH = 'offscreen.html'

async function ensureOffscreen(): Promise<void> {
  // hasDocument is the reliable existence check across Chrome versions.
  const has = await chrome.offscreen.hasDocument?.()
  if (has) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Record the tab video and audio for the bug report.',
  })
}

function getMediaStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const err = chrome.runtime.lastError
      if (err || !streamId) reject(new Error(err?.message ?? 'No stream id'))
      else resolve(streamId)
    })
  })
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function startMedia(
  sessionId: string,
  tabId: number,
  mic: boolean,
  transcribe: boolean,
): Promise<void> {
  const streamId = await getMediaStreamId(tabId)
  await ensureOffscreen()

  // The offscreen document exists after createDocument resolves, but its module
  // script may not have registered its onMessage listener yet — sending
  // immediately throws "Receiving end does not exist". Retry until it's ready.
  let lastErr: unknown
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_START',
        sessionId,
        streamId,
        mic,
        transcribe,
      } satisfies Msg)) as { ok?: boolean; error?: string } | undefined
      if (res && res.ok === false) throw new Error(res.error ?? 'Offscreen capture failed')
      return // delivered
    } catch (err) {
      lastErr = err
      const msg = (err as Error).message ?? ''
      // Only the "not ready yet" class of error is retryable.
      if (msg.includes('Receiving end does not exist') || msg.includes('message port closed')) {
        await delay(120)
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Offscreen document never became ready')
}

async function stopMedia(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.()
  if (!has) return
  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' } satisfies Msg)
  } catch {
    // offscreen may already be gone
  }
}

async function closeOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument?.()) {
    await chrome.offscreen.closeDocument().catch(() => {})
  }
}

/** Ask the offscreen document to turn the recorded video into keyframes. */
async function extractFrames(session: Session): Promise<void> {
  const specs = pickKeyframes(session)
  await chrome.runtime.sendMessage({
    type: 'EXTRACT_FRAMES',
    sessionId: session.id,
    specs,
  } satisfies Msg)
}

function counts(session: Session | null): CaptureCounts {
  const c: CaptureCounts = {
    network: 0,
    networkFailed: 0,
    console: 0,
    errors: 0,
    logs: 0,
    annotations: session?.annotations.length ?? 0,
    interactions: 0,
  }
  if (!session) return c
  for (const e of session.events) {
    if (e.kind === 'network') {
      c.network++
      if (e.failed || (e.status ?? 0) >= 400) c.networkFailed++
    } else if (e.kind === 'console') c.console++
    else if (e.kind === 'error') c.errors++
    else if (e.kind === 'log') c.logs++
    else if (e.kind === 'interaction') c.interactions++
  }
  return c
}

async function persist(): Promise<void> {
  if (!live) return
  live.durationMs = Date.now() - live.startedAt
  await saveSession(live)
}

async function rehydrate(): Promise<void> {
  if (live) return
  const id = await getActiveSessionId()
  if (!id) return
  const restored = await loadSession(id)
  // The debugger attachment does not survive worker eviction; mark the
  // recovered session as no-longer-recording so the user can still export it.
  if (restored) {
    restored.status = 'idle'
    live = restored
  }
}

// ── environment probe (runs in the page) ────────────────────────────────

async function probeEnvironment(tabId: number, url?: string, title?: string): Promise<EnvironmentMeta> {
  const base: EnvironmentMeta = { url, title }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        userAgent: navigator.userAgent,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        dpr: window.devicePixelRatio,
        connection: (navigator as any).connection?.effectiveType,
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    })
    const env = { ...base, ...(result as object) }
    return { ...env, ...(await detectFramework(tabId)) }
  } catch {
    return base
  }
}

/** Detect the page's JS framework — runs in the MAIN world to read page globals. */
async function detectFramework(tabId: number): Promise<Partial<EnvironmentMeta>> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const w = window as any
        const d = document
        if (w.__NEXT_DATA__) return { framework: 'Next.js' }
        const reactHook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__
        if (reactHook?.renderers?.size || w.React) {
          let version: string | undefined
          try {
            version = reactHook.renderers.values().next().value?.version
          } catch {
            /* ignore */
          }
          return { framework: 'React', frameworkVersion: version }
        }
        if (w.__VUE__ || w.Vue || d.querySelector('[data-v-app]')) {
          return { framework: 'Vue', frameworkVersion: w.Vue?.version }
        }
        const ngEl = d.querySelector('[ng-version]')
        if (ngEl) return { framework: 'Angular', frameworkVersion: ngEl.getAttribute('ng-version') || undefined }
        if (w.__svelte) return { framework: 'Svelte' }
        return {}
      },
    })
    return (result as Partial<EnvironmentMeta>) ?? {}
  } catch {
    return {}
  }
}

// ── recording lifecycle ──────────────────────────────────────────────────

async function startRecording(mic: boolean, transcribe: boolean): Promise<AckResponse> {
  if (live?.status === 'recording') return { ok: true }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return { ok: false, error: 'No active tab.' }
  if (/^(chrome|edge|about|chrome-extension|devtools|view-source|file):/i.test(tab.url ?? '')) {
    return { ok: false, error: 'Cannot record browser-internal, extension, or local-file pages.' }
  }
  // Per-site host access is granted at record time from the popup gesture. If
  // it's missing here, the popup guard was bypassed — fail with a clear hint.
  let originPattern: string | undefined
  try {
    originPattern = new URL(tab.url ?? '').origin + '/*'
  } catch {
    /* non-URL page — the scheme guard above already covers these */
  }
  if (originPattern && !(await chrome.permissions.contains({ origins: [originPattern] }))) {
    return { ok: false, error: 'Access to this site not granted. Click Record and choose Allow.' }
  }

  const startEpoch = Date.now()
  const session: Session = {
    id: `clip_${startEpoch.toString(36)}`,
    status: 'recording',
    tabId: tab.id,
    startedAt: startEpoch,
    durationMs: 0,
    meta: await probeEnvironment(tab.id, tab.url, tab.title),
    events: [],
    annotations: [],
    micRequested: mic,
    transcribeRequested: transcribe && mic,
  }

  const engine = new CdpSession(tab.id, startEpoch, (e) => {
    if (!live) return
    live.events.push(e)
    // Capture the DOM state at the moment an uncaught error fires (throttled).
    if (e.kind === 'error') void maybeSnapshotDom(tab.id!, e.tMs)
  })
  engine.onUnexpectedDetach = (reason) => {
    if (live) {
      live.status = 'error'
      live.attachError = `Debugger detached: ${reason}`
      void persist()
    }
    stopTimers()
    badge.clear()
    cdp = null
  }

  try {
    await engine.attach()
  } catch (err) {
    return {
      ok: false,
      error:
        (err as Error).message +
        ' — is DevTools open on this tab? Close it and retry (only one debugger client is allowed).',
    }
  }

  cdp = engine
  live = session
  overlayReady = false
  lastSnapshotAt = 0
  snapshotCount = 0
  await setActiveSessionId(session.id)
  await persist()
  badge.recording()

  // Start video/audio capture. A media failure must not abort the recording —
  // the CDP network/console/error capture is valuable on its own.
  try {
    await startMedia(session.id, tab.id, mic, !!session.transcribeRequested)
  } catch (err) {
    session.attachError = `Video capture unavailable: ${(err as Error).message}`
  }

  // Turn on the drawing overlay + interaction tracking in the page. If this
  // fails, the page's content script is stale (common right after reloading an
  // unpacked extension) — surface that so the popup can prompt a page reload.
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SET_OVERLAY',
      active: true,
      startEpoch: session.startedAt,
    } satisfies Msg)
    overlayReady = true
  } catch {
    overlayReady = false
  }

  persistTimer = setInterval(() => void persist(), 2000)
  return { ok: true }
}

async function stopRecording(): Promise<AckResponse> {
  if (!live) return { ok: false, error: 'Nothing is recording.' }
  live.status = 'stopping'
  stopTimers()
  if (cdp) {
    await cdp.detach()
    cdp = null
  }
  // Ask the offscreen recorder to finalize; it saves the blob and replies MEDIA_DONE.
  await stopMedia()
  const tabId = live.tabId
  live.status = 'idle'
  live.durationMs = Date.now() - live.startedAt
  await persist()
  badge.clear()
  chrome.tabs.sendMessage(tabId, { type: 'SET_OVERLAY', active: false } satisfies Msg).catch(() => {})
  return { ok: true }
}

async function onMediaDone(
  sessionId: string,
  ok: boolean,
  hasAudio: boolean,
  error?: string,
  transcript?: TranscriptSegment[],
): Promise<void> {
  // The session may be `live` (just stopped) or only in IndexedDB after eviction.
  const target = live?.id === sessionId ? live : await loadSession(sessionId)
  if (target) {
    target.hasVideo = ok
    target.hasAudio = hasAudio
    if (transcript?.length) target.transcript = transcript
    if (error && live?.id === sessionId) live.attachError = `Video: ${error}`
    if (target === live) await persist()
    else await saveSession(target)
  }

  if (ok && target) {
    // Keep the offscreen doc alive and extract keyframes; it will emit FRAMES_DONE.
    try {
      await extractFrames(target)
      return
    } catch {
      /* fall through to close */
    }
  }
  // No video (or extraction couldn't start) — free the tab-capture lock now.
  await closeOffscreen()
}

async function onFramesDone(sessionId: string, ok: boolean, count: number): Promise<void> {
  const target = live?.id === sessionId ? live : await loadSession(sessionId)
  if (target) {
    target.frameCount = ok ? count : 0
    if (target === live) await persist()
    else await saveSession(target)
  }
  await closeOffscreen()
}

function stopTimers(): void {
  if (persistTimer) {
    clearInterval(persistTimer)
    persistTimer = null
  }
}

// Throttle DOM snapshots: at most a few per session, spaced out — they're the
// most useful on the FIRST error and we don't want to flood the bundle.
const SNAPSHOT_MIN_GAP_MS = 4000
const SNAPSHOT_MAX = 4
let lastSnapshotAt = 0
let snapshotCount = 0

async function maybeSnapshotDom(tabId: number, tMs: number): Promise<void> {
  const now = Date.now()
  if (snapshotCount >= SNAPSHOT_MAX || now - lastSnapshotAt < SNAPSHOT_MIN_GAP_MS) return
  lastSnapshotAt = now
  snapshotCount++
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: 'SNAPSHOT_DOM',
      reason: 'uncaught-error',
    } satisfies Msg)) as SnapshotResponse
    if (res?.ok && res.tree && live) {
      const snap: DomSnapshotEvent = {
        id: `dom_${tMs.toString(36)}`,
        kind: 'dom',
        tMs,
        reason: 'uncaught-error',
        url: res.url,
        tree: res.tree,
      }
      live.events.push(snap)
    }
  } catch {
    // content script may not be present (e.g. cross-origin frame) — ignore
  }
}

function addInteraction(event: InteractionEvent): { ok: boolean } {
  if (live && live.status === 'recording') live.events.push(event)
  return { ok: true }
}

function captureVisible(windowId: number | undefined): Promise<{ dataUrl?: string }> {
  return new Promise((resolve) => {
    const cb = (dataUrl?: string) => {
      if (chrome.runtime.lastError || !dataUrl) resolve({})
      else resolve({ dataUrl })
    }
    const opts = { format: 'jpeg' as const, quality: 82 }
    if (typeof windowId === 'number') chrome.tabs.captureVisibleTab(windowId, opts, cb)
    else chrome.tabs.captureVisibleTab(opts, cb)
  })
}

function addPageEvent(event: CaptureEvent): { ok: boolean } {
  // Page-hook errors/console (fallback to CDP). De-duplication happens at
  // bundle time so CDP + page-hook copies don't double-count.
  if (live && live.status === 'recording') live.events.push(event)
  return { ok: true }
}

async function exportBundle(id?: string): Promise<ExportResponse> {
  await rehydrate()
  const session = id ? (live?.id === id ? live : await loadSession(id)) : live
  if (!session) return { ok: false, error: 'No captured session to export.' }
  const frames = await loadFrames(session.id)
  const sources = await fetchErrorSources(session)
  const ctx = buildAgentContext(session, frames?.frames, sources, !!frames?.storyboard)
  const json = JSON.stringify(ctx, null, 2)
  // Popup performs the actual download (SW has no DOM). Return the payload.
  return {
    ok: true,
    filename: `${session.id}.agent-context.json`,
    // @ts-expect-error — extend the response with the payload for the popup
    json,
  }
}

/**
 * Fetch the source files referenced by errors so the bundle can show a few
 * lines around each failure. The background can fetch cross-origin (it holds
 * host permissions), which content scripts can't.
 */
async function fetchErrorSources(session: Session): Promise<Record<string, string[]>> {
  const urls = new Set<string>()
  for (const e of session.events) {
    if (e.kind === 'error') {
      if (e.url) urls.add(e.url)
      e.stackFrames?.forEach((f) => f.url && urls.add(f.url))
    } else if (e.kind === 'console' && e.level === 'error') {
      if (e.url) urls.add(e.url)
      e.stackFrames?.forEach((f) => f.url && urls.add(f.url))
    }
  }
  const out: Record<string, string[]> = {}
  await Promise.all(
    [...urls].slice(0, 25).map(async (url) => {
      if (!/^https?:/.test(url)) return
      try {
        const r = await fetch(url)
        if (!r.ok) return
        const text = await r.text()
        if (text.length <= 2_000_000) out[url] = text.split('\n')
      } catch {
        // cross-origin opaque / gone — skip; the stack still points at it
      }
    }),
  )
  return out
}

async function getHistory(): Promise<HistoryResponse> {
  const sessions = await listSessions()
  const summaries: SessionSummary[] = sessions
    .filter((s) => s.status !== 'recording') // exclude the in-flight one
    .map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      url: s.meta.url,
      title: s.meta.title,
      counts: counts(s),
      hasVideo: !!s.hasVideo,
      frameCount: s.frameCount ?? 0,
    }))
  return { sessions: summaries }
}

async function removeSession(id: string): Promise<AckResponse> {
  await deleteSession(id)
  if (live?.id === id) {
    live = null
    await setActiveSessionId(null)
  }
  return { ok: true }
}

function getState(): StateResponse {
  return {
    status: live?.status ?? 'idle',
    counts: counts(live),
    durationMs: live ? (live.status === 'recording' ? Date.now() - live.startedAt : live.durationMs) : 0,
    tabId: live?.tabId,
    url: live?.meta.url,
    attachError: live?.attachError,
    sessionId: live?.id,
    hasVideo: !!live?.hasVideo,
    micActive: !!live?.micRequested,
    frameCount: live?.frameCount ?? 0,
    needsPageReload: live?.status === 'recording' && !overlayReady,
  }
}

function addAnnotation(annotation: Annotation): AckResponse {
  if (!live) return { ok: false, error: 'Not recording.' }
  // Replace if this id already exists (idempotent re-send), else append.
  const i = live.annotations.findIndex((a) => a.id === annotation.id)
  if (i >= 0) live.annotations[i] = annotation
  else live.annotations.push(annotation)
  return { ok: true }
}

function removeAnnotation(id: string): AckResponse {
  if (live) live.annotations = live.annotations.filter((a) => a.id !== id)
  return { ok: true }
}

function clearAnnotations(): AckResponse {
  if (live) live.annotations = []
  return { ok: true }
}

// ── message router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  // These are addressed to the offscreen document / content script; ignore here.
  if (
    msg.type === 'OFFSCREEN_START' ||
    msg.type === 'OFFSCREEN_STOP' ||
    msg.type === 'EXTRACT_FRAMES' ||
    msg.type === 'SNAPSHOT_DOM' ||
    msg.type === 'SET_OVERLAY'
  )
    return false
  ;(async () => {
    await rehydrate()
    switch (msg.type) {
      case 'START_RECORDING':
        return sendResponse(await startRecording(!!msg.mic, !!msg.transcribe))
      case 'STOP_RECORDING':
        return sendResponse(await stopRecording())
      case 'GET_STATE':
        return sendResponse(getState())
      case 'EXPORT_BUNDLE':
        return sendResponse(await exportBundle(msg.id))
      case 'GET_HISTORY':
        return sendResponse(await getHistory())
      case 'DELETE_SESSION':
        return sendResponse(await removeSession(msg.id))
      case 'ADD_ANNOTATION':
        return sendResponse(addAnnotation(msg.annotation))
      case 'REMOVE_ANNOTATION':
        return sendResponse(removeAnnotation(msg.id))
      case 'CLEAR_ANNOTATIONS':
        return sendResponse(clearAnnotations())
      case 'ADD_INTERACTION':
        return sendResponse(addInteraction(msg.event))
      case 'ADD_EVENT':
        return sendResponse(addPageEvent(msg.event))
      case 'CAPTURE_VISIBLE':
        return sendResponse(await captureVisible(sender.tab?.windowId))
      case 'MEDIA_DONE':
        await onMediaDone(msg.sessionId, msg.ok, msg.hasAudio, msg.error, msg.transcript)
        return sendResponse({ ok: true })
      case 'FRAMES_DONE':
        await onFramesDone(msg.sessionId, msg.ok, msg.count)
        return sendResponse({ ok: true })
      case 'CONTENT_READY': {
        // Re-arm the overlay + tracker after a navigation loaded a fresh content
        // script on the tab we're recording, sharing the original start epoch.
        const active = live?.status === 'recording' && sender.tab?.id === live.tabId
        if (active) overlayReady = true // a fresh page re-armed the overlay/tracker
        return sendResponse({
          ok: true,
          active,
          startEpoch: active ? live!.startedAt : undefined,
        })
      }
      default:
        return sendResponse({ ok: false })
    }
  })()
  return true // keep the channel open for the async response
})

// Clean up if the recorded tab closes mid-capture.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (live && live.tabId === tabId && live.status === 'recording') {
    await stopRecording()
  }
})

chrome.runtime.onStartup.addListener(() => void rehydrate())
