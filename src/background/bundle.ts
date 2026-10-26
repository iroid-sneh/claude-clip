// ─────────────────────────────────────────────────────────────────────────
// Bundle builder — turns a captured Session into agent-context.json v2.
//
// The output is engineered for how Claude reads (PLAN.md §7):
//   readme (self-describing) → repro-ready timeline → error-first detail →
//   network summary + detail-by-id → annotations → redaction provenance.
//
// Every event is correlated on one causal timeline. A console error that
// fires right after a failed request is linked to it (caused_by), which is
// what lets Claude follow click → request → error → symptom.
// ─────────────────────────────────────────────────────────────────────────

import type {
  Annotation,
  BrowserLogEvent,
  CaptureEvent,
  ConsoleEvent,
  DomSnapshotEvent,
  ElementInfo,
  ErrorEvent,
  FrameRecord,
  InteractionEvent,
  NetworkEvent,
  Session,
  StackFrame,
} from '@/shared/types'
import { Redactor } from './redact'
import { isTrackingNoise } from './noise'

const CORRELATION_WINDOW_MS = 1500 // link an error to a failed request within this window

export interface AgentContext {
  version: 2
  id: string
  createdAt: string
  readme: {
    /** 'bug' when errors/failed requests exist; 'feedback' when it's an
     * annotation-only change request. Switches read_order + guidance. */
    mode: ClipMode
    /** One-line intent summary — read this FIRST, before the raw timeline. */
    agent_brief: string
    what_this_is: string
    app: { url?: string; title?: string }
    environment: Record<string, unknown>
    observed_symptom: string
    primary_suspect: string
    read_order: string[]
  }
  repro_steps: string[]
  session: { id: string; started_at: string; duration_ms: number }
  video: { present: boolean; has_audio: boolean; storage: string; note: string }
  transcript: { status: string; note?: string; segments: { t_ms: number; text: string }[] }
  frames: FrameManifestEntry[]
  timeline: TimelineEntry[]
  dom_snapshots: { t_ms: number; reason: string; url?: string; tree: string }[]
  errors: ErrorDetail[]
  network_summary: NetworkSummary[]
  network_detail: Record<string, NetworkDetail>
  browser_logs: { t_ms: number; source: string; level: string; text: string }[]
  annotations: AnnotationDetail[]
  redaction: { applied: string[]; note: string }
}

interface AnnotationDetail {
  /** The mark number shown on the page (1, 2, 3…). */
  mark?: number
  t_ms: number
  type: string
  /** The user's typed note for this specific mark. */
  note?: string
  /** What the mark points at / encircles (same block as click elements). */
  points_at?: ElementBlock
  outer_html?: string
  styles?: Record<string, string>
  url?: string
  viewport?: { w: number; h: number }
  /** Attached image file (in the .clip) of the marked region — view this. */
  image?: string
  /** Soft warning when the note text and the selected element seem to disagree
   * (e.g. note says "name" but the element is a time value) — ask, don't guess. */
  possible_mismatch?: string
}

/** How to read this clip: a crash to debug vs a change the user is requesting. */
type ClipMode = 'bug' | 'feedback'

interface ElementBlock {
  component?: string
  component_minified?: boolean
  testid?: string
  selector?: string
  dom_path?: string
  role?: string
  text?: string
  rect?: { x: number; y: number; w: number; h: number }
}

interface TimelineEntry {
  t_ms: number
  type: string
  ref?: string
  summary: string
  caused_by?: string
  /** Full stable identity of the interacted element (clicks). */
  element?: ElementBlock
  /** True when a rage/dead click actually lands on a freshly-annotated element
   * — i.e. the user was demonstrating, not hitting a broken control. */
  user_indicated?: boolean
}

/** A minified component name is a short opaque code (V5, Ts) — not mappable. */
function isMinified(name?: string): boolean {
  return !!name && name.length <= 3
}

function rectsOverlap(
  a?: { x: number; y: number; w: number; h: number },
  b?: { x: number; y: number; w: number; h: number },
): boolean {
  if (!a || !b) return false
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * A rage/dead click that lands on a freshly-annotated element is the user
 * DEMONSTRATING (pointing something out), not hitting a broken control. Return
 * the ids of such clicks so their frustration labels can be corrected — works
 * even when narration failed (annotation-overlap, like transcript-overlap).
 */
const INDICATE_WINDOW_MS = 12000

function markUserIndicated(interactions: InteractionEvent[], annotations: Annotation[]): Set<string> {
  const out = new Set<string>()
  if (!annotations.length) return out
  for (const c of interactions) {
    if (c.action !== 'click' || !(c.rage || c.dead)) continue
    for (const a of annotations) {
      if (Math.abs(a.tMs - c.tMs) > INDICATE_WINDOW_MS) continue
      const sameSelector =
        !!a.target?.selector && a.target.selector === c.element?.selector
      const overlaps = rectsOverlap(a.target?.rect, c.element?.rect)
      const insideAnno =
        a.target?.rect != null &&
        c.x != null &&
        c.y != null &&
        c.x >= a.target.rect.x &&
        c.x <= a.target.rect.x + a.target.rect.w &&
        c.y >= a.target.rect.y &&
        c.y <= a.target.rect.y + a.target.rect.h
      if (sameSelector || overlaps || insideAnno) {
        out.add(c.id)
        break
      }
    }
  }
  return out
}

/** Shared element extractor — the SAME block for clicks and annotations. */
function elementBlock(info: ElementInfo | undefined, redact: Redactor): ElementBlock | undefined {
  if (!info) return undefined
  const block: ElementBlock = {
    component: info.component,
    testid: info.testid,
    selector: info.selector,
    dom_path: info.domPath,
    role: info.role,
    text: info.text ? redact.text(info.text) : undefined,
    rect: info.rect,
  }
  if (isMinified(info.component)) block.component_minified = true
  return block
}

interface FrameManifestEntry {
  label: string // "Image 1" — matches the attached storyboard cell
  t_ms: number
  caption: string
  trigger: string
  url?: string
  viewport?: { w: number; h: number }
}

interface SourceLine {
  line: number
  code: string
  is_error: boolean
}

interface ErrorDetail {
  id: string
  /** Where this error was observed: exception | console | network | browser */
  source: string
  type: string
  message: string
  t_ms: number
  url?: string
  line?: number
  stacktrace?: string
  stack_frames?: StackFrame[]
  source_context?: SourceLine[]
  related_network?: string
  status?: number
  response_body?: string
}

interface NetworkSummary {
  id: string
  method: string
  url: string
  status?: number
  duration_ms?: number
  size_bytes?: number
  failed?: boolean
  detail?: string
}

interface NetworkDetail {
  request: { headers?: Record<string, string>; body?: string; initiator?: string }
  response: {
    status?: number
    headers?: Record<string, string>
    body?: string
    truncated?: boolean
  }
  timing?: { ttfb_ms?: number; total_ms?: number }
  error?: { text?: string; blocked_reason?: string; cors?: string }
}

export function buildAgentContext(
  session: Session,
  frames?: FrameRecord[],
  sources: Record<string, string[]> = {},
  hasStoryboard = false,
): AgentContext {
  const redact = new Redactor()
  // Drop errors/console that originate from extension code (this recorder or
  // any other extension) — they are never the app's bug and must not pollute
  // errors[] / primary_suspect.
  const events = orderCausally(session.events.filter((e) => !isRecorderNoise(e)))
  const network = events.filter((e): e is NetworkEvent => e.kind === 'network')
  const exceptions = events.filter((e): e is ErrorEvent => e.kind === 'error')
  const logs = events.filter((e): e is BrowserLogEvent => e.kind === 'log')
  const interactions = events.filter((e): e is InteractionEvent => e.kind === 'interaction')
  const domSnapshots = events.filter((e): e is DomSnapshotEvent => e.kind === 'dom')

  correlateErrorsToNetwork(exceptions, network)
  const errors = buildErrors(events, network, redact, sources)

  const warnings = events.filter(
    (e): e is ConsoleEvent => e.kind === 'console' && e.level === 'warn',
  )
  const userIndicated = markUserIndicated(interactions, session.annotations)
  const timeline = buildTimeline(events, redact, userIndicated)
  const { summary, detail } = buildNetwork(network, redact)
  // Dead/rage clicks the user did NOT annotate are candidate broken controls —
  // a real bug signal even when no JS error fired.
  const deadClicks = interactions.filter(
    (e) => e.action === 'click' && (e.dead || e.rage) && !userIndicated.has(e.id),
  )
  const primarySuspect = redact.text(derivePrimarySuspect(errors, warnings, deadClicks))

  // Classify the clip. Errors or failed requests → a bug to debug. Otherwise
  // it's an annotation/feedback clip — a request to change behavior or looks,
  // not a crash. The mode flips read_order and the guidance below.
  const mode: ClipMode = errors.length > 0 ? 'bug' : 'feedback'
  const agentBrief = redact.text(
    buildBrief(mode, session.annotations, errors, deadClicks, primarySuspect),
  )

  return {
    version: 2,
    id: session.id,
    createdAt: new Date().toISOString(),
    readme: {
      mode,
      agent_brief: agentBrief,
      what_this_is:
        mode === 'bug'
          ? 'Claude Clip bug capture. The timeline is causal (caused_by); start from errors, correlate to network_detail by id. agent_brief summarizes intent.'
          : 'Claude Clip feedback / change-request capture. NO errors or failed requests were recorded — this is a request to change behavior or appearance, not a crash. Start from agent_brief and annotations (the user\'s marks + notes); use frames and timeline for context. Do not hunt for a nonexistent error.',
      app: { url: redact.url(session.meta.url ?? ''), title: session.meta.title },
      environment: {
        userAgent: session.meta.userAgent,
        viewport: session.meta.viewport,
        dpr: session.meta.dpr,
        connection: session.meta.connection,
        locale: session.meta.locale,
        timezone: session.meta.timezone,
        framework: session.meta.framework,
        frameworkVersion: session.meta.frameworkVersion,
      },
      observed_symptom: redact.text(
        deriveObservedSymptom(session.annotations, primarySuspect, deadClicks),
      ),
      primary_suspect: primarySuspect,
      read_order:
        mode === 'bug'
          ? [
              'agent_brief',
              'repro_steps',
              'transcript',
              'frames',
              'timeline',
              'errors',
              'network_summary',
              'network_detail',
              'dom_snapshots',
              'browser_logs',
            ]
          : [
              'agent_brief',
              'annotations',
              'transcript',
              'frames',
              'timeline',
              'repro_steps',
              'network_summary',
            ],
    },
    repro_steps: buildReproSteps(interactions, redact),
    session: {
      id: session.id,
      started_at: new Date(session.startedAt).toISOString(),
      duration_ms: session.durationMs,
    },
    video: {
      present: !!session.hasVideo,
      has_audio: !!session.hasAudio,
      storage: `indexeddb://claude-clip/videos/${session.id}`,
      note:
        frames?.length && hasStoryboard
          ? 'A storyboard PNG of labeled keyframes is attached alongside this JSON. Match each "frames" entry to its "Image N" cell to see the moment referenced by the timeline.'
          : frames?.length
            ? 'Keyframe metadata is listed in "frames" (label/time/caption), but the storyboard image is NOT attached in this bundle.'
            : 'No keyframes were extracted for this session.',
    },
    transcript: buildTranscript(session),
    frames: (frames ?? []).map((f) => ({
      label: f.label,
      t_ms: f.tMs,
      caption: redact.text(f.caption),
      trigger: f.trigger,
      url: f.url ? redact.url(f.url) : undefined,
      viewport: f.viewport,
    })),
    timeline,
    dom_snapshots: domSnapshots.map((d) => ({
      t_ms: d.tMs,
      reason: d.reason,
      url: d.url ? redact.url(d.url) : undefined,
      tree: redact.text(d.tree),
    })),
    errors,
    network_summary: summary,
    network_detail: detail,
    browser_logs: logs.map((l) => ({
      t_ms: l.tMs,
      source: l.source,
      level: l.level,
      text: redact.text(l.text),
    })),
    annotations: session.annotations.map((a): AnnotationDetail => {
      const points_at = elementBlock(a.target, redact)
      const mismatch = noteElementMismatch(a.note, points_at)
      return {
        mark: a.index,
        t_ms: a.tMs,
        type: a.type,
        // Omit the key entirely when there's no note (never emit note: undefined).
        ...(a.note ? { note: redact.text(a.note) } : {}),
        points_at,
        outer_html: a.outerHTML ? redact.text(a.outerHTML) : undefined,
        styles: a.styles,
        url: a.url ? redact.url(a.url) : undefined,
        viewport: a.viewport,
        image: a.image ? `annotations/mark-${a.index ?? 0}.jpg` : undefined,
        ...(mismatch ? { possible_mismatch: mismatch } : {}),
      }
    }),
    redaction: {
      applied: redact.provenance(),
      note: redact.applied.size
        ? 'Sensitive values were masked client-side before export (auth headers, cookies, known secret shapes, and PII).'
        : 'Redaction ran client-side; no sensitive values were detected in the captured data.',
    },
  }
}

/**
 * Sort by time, but pull a navigation user-action ahead of the page-load
 * effects it caused (the document GET + a couple of load events often land a
 * few ms *before* the navigation breadcrumb, since the breadcrumb is emitted
 * when the new page's content script boots). Ordering cause → effect makes the
 * first second of each navigation read cleanly for a causal consumer.
 */
function orderCausally(raw: CaptureEvent[]): CaptureEvent[] {
  const events = [...raw].sort((a, b) => a.tMs - b.tMs)
  const EPS = 500
  const isEffect = (e: CaptureEvent) =>
    e.kind === 'network' || e.kind === 'dom' || e.kind === 'log'
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.kind === 'interaction' && e.action === 'navigation') {
      let j = i - 1
      while (j >= 0 && e.tMs - events[j].tMs <= EPS && isEffect(events[j])) j--
      const target = j + 1
      if (target < i) {
        events.splice(i, 1)
        events.splice(target, 0, e)
      }
    }
  }
  return events
}

/** Attach related_network to each error using a short backward time window. */
function correlateErrorsToNetwork(errors: ErrorEvent[], network: NetworkEvent[]): void {
  const failed = network.filter((n) => n.failed || (n.status ?? 0) >= 400)
  for (const err of errors) {
    let best: NetworkEvent | undefined
    for (const n of failed) {
      const dt = err.tMs - n.tMs
      if (dt >= 0 && dt <= CORRELATION_WINDOW_MS) {
        if (!best || err.tMs - n.tMs < err.tMs - best.tMs) best = n
      }
    }
    if (best) err.relatedNetwork = best.id
  }
}

function buildTimeline(
  events: CaptureEvent[],
  redact: Redactor,
  userIndicated: Set<string>,
): TimelineEntry[] {
  return events.map((e) => {
    switch (e.kind) {
      case 'network':
        return {
          t_ms: e.tMs,
          type: 'network',
          ref: e.id,
          summary: `${e.method} ${redact.url(shorten(stubUrl(e.url)))} → ${
            e.failed ? `FAILED (${e.errorText ?? e.corsError ?? 'error'})` : e.status ?? '—'
          }`,
        }
      case 'error':
        return {
          t_ms: e.tMs,
          type: 'error',
          ref: e.id,
          summary: redact.text(`${e.exceptionType}: ${e.message}`),
          caused_by: e.relatedNetwork,
        }
      case 'console':
        return {
          t_ms: e.tMs,
          type: 'console',
          ref: e.id,
          summary: redact.text(`[${e.level}] ${shorten(e.text, 160)}`),
        }
      case 'log':
        return {
          t_ms: e.tMs,
          type: 'browser_log',
          ref: e.id,
          summary: redact.text(`[${e.source}/${e.level}] ${shorten(e.text, 160)}`),
        }
      case 'interaction': {
        const indicated = userIndicated.has(e.id)
        return {
          t_ms: e.tMs,
          type: 'user_action',
          ref: e.id,
          summary: redact.text(interactionSummary(e, indicated)),
          element: e.action === 'click' ? elementBlock(e.element, redact) : undefined,
          user_indicated: indicated || undefined,
        }
      }
      case 'dom':
        return {
          t_ms: e.tMs,
          type: 'dom_snapshot',
          ref: e.id,
          summary: `DOM snapshot captured (${e.reason})`,
        }
    }
  })
}

function interactionSummary(e: InteractionEvent, indicated = false): string {
  // user-indicated (annotated) beats the frustration read; else RAGE/DEAD.
  const flags = indicated
    ? 'user-indicated'
    : [e.rage && 'RAGE', e.dead && 'DEAD'].filter(Boolean).join('/')
  const tag = flags ? ` [${flags}]` : ''
  // Prefer stable identity for the label. Only show a component name if it's
  // not a minified opaque code (V5, Ts).
  const comp = e.element?.component && !isMinified(e.element.component) ? `<${e.element.component}> ` : ''
  const id = e.element?.testid ? ` [testid=${e.element.testid}]` : ''
  switch (e.action) {
    case 'click':
      return `click ${comp}${e.label ? `"${e.label}"` : e.element?.selector ?? e.target ?? ''}${id}${tag}`
    case 'input':
      return `input ${e.label ? `"${e.label}"` : e.target ?? ''} = ${e.value ?? ''}`
    case 'navigation':
      return `navigate → ${e.url ?? ''}`
    case 'scroll':
      return `scroll ${e.value ?? ''}`
    case 'submit':
      return `submit ${e.target ?? ''}`
    default:
      return `${e.action} ${e.target ?? ''}`
  }
}

/** Human-readable reproduction steps from the interaction stream. */
function buildReproSteps(interactions: InteractionEvent[], redact: Redactor): string[] {
  const steps: string[] = []
  for (const e of interactions) {
    if (e.action === 'scroll') continue // too granular for repro steps
    let step: string
    if (e.action === 'click') {
      step = `Click ${e.label ? `"${e.label}"` : e.target ?? 'element'}`
      if (e.rage) step += ' (clicked repeatedly — nothing happened)'
      else if (e.dead) step += ' (no visible response)'
    } else if (e.action === 'input') {
      step = `Enter ${e.value ?? 'a value'} in ${e.label ? `"${e.label}"` : e.target ?? 'field'}`
    } else if (e.action === 'navigation') {
      step = `Navigate to ${e.url ?? ''}`
    } else {
      step = `${e.action} ${e.target ?? ''}`
    }
    steps.push(redact.text(step))
  }
  return steps.slice(0, 30)
}

function buildNetwork(
  network: NetworkEvent[],
  redact: Redactor,
): {
  summary: NetworkSummary[]
  detail: Record<string, NetworkDetail>
} {
  const detail: Record<string, NetworkDetail> = {}
  const summary: NetworkSummary[] = network.map((n) => {
    const isInteresting = n.failed || (n.status ?? 0) >= 400 || !!n.requestBody
    const s: NetworkSummary = {
      id: n.id,
      method: n.method,
      url: redact.url(stubUrl(n.url)),
      status: n.status,
      duration_ms: n.durationMs,
      size_bytes: n.sizeBytes,
      failed: n.failed,
    }
    if (isInteresting) {
      const detailId = `${n.id}_detail`
      s.detail = detailId
      detail[detailId] = {
        request: {
          headers: redact.headers(n.requestHeaders),
          body: n.requestBody ? redact.text(n.requestBody) : undefined,
          initiator: n.initiator,
        },
        response: {
          status: n.status,
          headers: redact.headers(n.responseHeaders),
          body: n.responseBody ? redact.text(n.responseBody) : undefined,
          truncated: n.responseBodyTruncated,
        },
        timing: { ttfb_ms: n.ttfbMs, total_ms: n.durationMs },
        error: n.failed
          ? { text: n.errorText, blocked_reason: n.blockedReason, cors: n.corsError }
          : undefined,
      }
    }
    return s
  })
  // Error-first ordering: failed / non-2xx requests float to the top.
  summary.sort((a, b) => rank(b) - rank(a))
  return { summary, detail }
}

function rank(s: NetworkSummary): number {
  if (s.failed) return 3
  if ((s.status ?? 0) >= 500) return 2
  if ((s.status ?? 0) >= 400) return 1
  return 0
}

// ── unified errors array ────────────────────────────────────────────────────
// Everything an app-level consumer would call "an error", from every source,
// so read_order → errors is reliable: uncaught exceptions, console.error,
// failed / 4xx / 5xx / CORS requests, and browser error logs (CSP/mixed).

const CONTEXT_BEFORE = 4
const CONTEXT_AFTER = 3

function buildErrors(
  events: CaptureEvent[],
  network: NetworkEvent[],
  redact: Redactor,
  sources: Record<string, string[]>,
): ErrorDetail[] {
  const out: ErrorDetail[] = []
  const netById = new Map(network.map((n) => [n.id, n]))

  for (const e of events) {
    if (e.kind === 'error') {
      out.push({
        id: e.id,
        source: 'exception',
        type: e.exceptionType,
        message: redact.text(e.message),
        t_ms: e.tMs,
        url: e.url ? redact.url(e.url) : undefined,
        line: e.line,
        stacktrace: redact.text(e.stack),
        stack_frames: redactFrames(e.stackFrames, redact),
        source_context: contextFor(e.url, e.line, e.stackFrames, sources),
        related_network: e.relatedNetwork,
      })
    } else if (e.kind === 'console' && e.level === 'error') {
      const top = e.stackFrames?.[0]
      out.push({
        id: e.id,
        source: 'console',
        type: 'console.error',
        message: redact.text(e.text),
        t_ms: e.tMs,
        url: e.url ? redact.url(e.url) : top?.url ? redact.url(top.url) : undefined,
        line: e.line ?? top?.line,
        stacktrace: redact.text(e.stack),
        stack_frames: redactFrames(e.stackFrames, redact),
        source_context: contextFor(e.url, e.line, e.stackFrames, sources),
      })
    } else if (e.kind === 'network' && (e.failed || (e.status ?? 0) >= 400 || e.malformed)) {
      if (isTrackingNoise(e.url)) continue // analytics beacons aren't app errors
      const label = e.malformed
        ? 'Malformed JSON response'
        : e.failed
          ? e.errorText ?? e.corsError ?? 'request failed'
          : `HTTP ${e.status}`
      out.push({
        id: e.id,
        source: 'network',
        type: e.corsError ? `CORS ${e.corsError}` : label,
        message: redact.text(
          `${e.method} ${stubUrl(e.url)} → ${e.malformed ? `${e.status} but body is not valid JSON` : e.failed ? label : e.status}`,
        ),
        t_ms: e.tMs,
        url: redact.url(stubUrl(e.url)),
        status: e.status,
        related_network: e.id,
        // Full raw body so the consumer can show the exact broken part + fix.
        response_body: e.responseBody ? redact.text(e.responseBody) : undefined,
      })
    } else if (e.kind === 'log' && e.level === 'error') {
      out.push({
        id: e.id,
        source: 'browser',
        type: e.category ? `${e.source}/${e.category}` : e.source,
        message: redact.text(e.text),
        t_ms: e.tMs,
        url: e.url ? redact.url(e.url) : undefined,
        related_network: e.networkRequestId
          ? netById.get(e.networkRequestId)?.id
          : undefined,
      })
    }
  }

  return dedupeErrors(out.sort((a, b) => a.t_ms - b.t_ms))
}

/**
 * The CDP layer and the page-hook fallback can both report the same error.
 * Collapse near-duplicate messages within a short window, preferring the entry
 * with the richer stack (usually CDP).
 */
function dedupeErrors(errors: ErrorDetail[]): ErrorDetail[] {
  const DEDUP_MS = 1500
  const kept: ErrorDetail[] = []
  for (const e of errors) {
    const key = normalizeMsg(e.message)
    const dup = kept.find(
      (k) => normalizeMsg(k.message) === key && Math.abs(k.t_ms - e.t_ms) <= DEDUP_MS,
    )
    if (!dup) {
      kept.push(e)
    } else if ((e.stacktrace?.length ?? 0) > (dup.stacktrace?.length ?? 0)) {
      // Replace the weaker duplicate with the richer one.
      kept[kept.indexOf(dup)] = { ...e, id: dup.id }
    }
  }
  return kept
}

function normalizeMsg(m: string): string {
  return m.replace(/\s+/g, ' ').trim().slice(0, 120).toLowerCase()
}

function redactFrames(frames: StackFrame[] | undefined, redact: Redactor): StackFrame[] | undefined {
  if (!frames?.length) return undefined
  return frames.map((f) => ({ ...f, url: f.url ? redact.url(f.url) : undefined }))
}

/** A few source lines around the failure so the consumer can point at the fix. */
function contextFor(
  url: string | undefined,
  line: number | undefined,
  frames: StackFrame[] | undefined,
  sources: Record<string, string[]>,
): SourceLine[] | undefined {
  // Prefer the error's own url/line; else the top stack frame with a source.
  let u = url
  let l = line
  if ((!u || !sources[u]) && frames) {
    const hit = frames.find((f) => f.url && sources[f.url])
    if (hit) {
      u = hit.url
      l = hit.line
    }
  }
  if (!u || !l || !sources[u]) return undefined
  const lines = sources[u]
  const start = Math.max(0, l - 1 - CONTEXT_BEFORE)
  const end = Math.min(lines.length, l + CONTEXT_AFTER)
  const ctx: SourceLine[] = []
  for (let i = start; i < end; i++) {
    ctx.push({ line: i + 1, code: lines[i], is_error: i + 1 === l })
  }
  return ctx.length ? ctx : undefined
}

function buildTranscript(session: Session): AgentContext['transcript'] {
  const segs = session.transcript ?? []
  if (segs.length) {
    return {
      status: 'ready',
      note: 'Spoken narration transcribed on-device via the browser speech API. The consumer cannot hear audio — read this instead.',
      segments: segs.map((s) => ({ t_ms: s.tStartMs, text: s.text })),
    }
  }
  // Audio was recorded but no text came out → spoken intent may be LOST.
  // Flag it loudly so the consumer doesn't read "no transcript" as "nothing said".
  if (session.hasAudio) {
    return {
      status: 'failed',
      note: 'Audio WAS recorded but transcription produced no text — spoken intent may be lost. Do not treat the empty transcript as "nothing was said". Rely on the annotations/notes for intent, and the user should add a text note next time.',
      segments: [],
    }
  }
  if (session.transcribeRequested) {
    return {
      status: 'failed',
      note: 'Transcription was requested but produced no text (no audio captured).',
      segments: [],
    }
  }
  return {
    status: 'none',
    note: 'Narration was not transcribed. The video may still contain audio the consumer cannot hear.',
    segments: [],
  }
}

/**
 * The user's arrow/circle is the strongest statement of intent — surface it.
 * Prefer any written note, else describe what the first mark points at.
 */
function annotationWhere(a: Annotation): string {
  return (
    (a.target?.text && shorten(a.target.text, 50)) ||
    (a.target?.component && !isMinified(a.target.component) && `<${a.target.component}>`) ||
    a.target?.selector ||
    'an element'
  )
}

function deriveObservedSymptom(
  annotations: Annotation[],
  primarySuspect: string,
  deadClicks: InteractionEvent[] = [],
): string {
  // The user's typed notes are the strongest statement of intent — surface each
  // one tied to what its mark points at ("mark 1 says X at Y; mark 2 says Z…").
  const noted = annotations.filter((a) => a.note)
  if (noted.length === 1) {
    const a = noted[0]
    return `${a.note} (marked on ${annotationWhere(a)}).`
  }
  if (noted.length > 1) {
    const parts = noted.map((a) => `(${a.index ?? '?'}) "${a.note}" on ${annotationWhere(a)}`)
    return `User left ${noted.length} notes: ${parts.join('; ')}.`
  }
  // Marks without notes.
  const a = annotations[0]
  if (a) {
    const verb = a.type === 'arrow' ? 'drew an arrow at' : a.type === 'ellipse' ? 'circled' : `marked`
    return `User ${verb} ${annotationWhere(a)}.`
  }
  // No annotation — a dead/no-response click is a concrete symptom on its own.
  if (deadClicks.length) return deadClickSummary(deadClicks)
  // Else point at the strongest captured signal.
  if (!/^No errors/.test(primarySuspect)) {
    return `No annotation drawn. Strongest signal: ${primarySuspect}`
  }
  return 'No annotation or error captured — see timeline for the user session.'
}

function derivePrimarySuspect(
  errors: ErrorDetail[],
  warnings: ConsoleEvent[],
  deadClicks: InteractionEvent[] = [],
): string {
  // Prefer a real app error over tracking/beacon noise (already excluded from
  // the network-sourced errors) — first by time.
  const first = errors[0]
  if (first) {
    const loc = first.url ? ` (${shorten(first.url)}${first.line ? `:${first.line}` : ''})` : ''
    return `${first.type}: ${shorten(first.message, 120)}${loc}`
  }
  // No JS error, but a click that did nothing is a broken-control candidate.
  if (deadClicks.length) return deadClickSummary(deadClicks)
  // No errors, but console warnings are still a real signal — summarize them.
  if (warnings.length) return summarizeWarnings(warnings)
  return 'No errors or failed requests captured.'
}

/** Describe the first dead/rage click as a broken-control candidate. */
function deadClickSummary(deadClicks: InteractionEvent[]): string {
  const c = deadClicks[0]
  const what = c.label || c.element?.text || c.element?.selector || c.target || 'a control'
  const kind = c.rage ? 'clicked repeatedly with no response (rage click)' : 'produced no visible response (dead click)'
  const more = deadClicks.length > 1 ? ` (+${deadClicks.length - 1} more)` : ''
  return `A click on ${shorten(String(what), 60)} ${kind} — likely a broken handler${more}.`
}

/**
 * One-line intent summary placed at the very top (readme.agent_brief). The
 * developer and the agent both read this before the raw timeline, so it must
 * state the mode, the change requests / suspect, and any dead-click signal.
 */
function buildBrief(
  mode: ClipMode,
  annotations: Annotation[],
  errors: ErrorDetail[],
  deadClicks: InteractionEvent[],
  primarySuspect: string,
): string {
  const parts: string[] = []
  const noted = annotations.filter((a) => a.note)

  if (mode === 'bug') {
    parts.push(
      `Bug clip — ${errors.length} error${errors.length === 1 ? '' : 's'} captured. Primary suspect: ${shorten(primarySuspect, 100)}`,
    )
    if (annotations.length) {
      parts.push(
        `User also marked ${annotations.length} spot${annotations.length === 1 ? '' : 's'}${noted.length ? `: ${noted.map((a) => `(${a.index ?? '?'}) "${shorten(a.note!, 60)}"`).join('; ')}` : ''}.`,
      )
    }
  } else {
    const n = annotations.length
    parts.push(
      `Feedback clip — no errors. ${n} change request${n === 1 ? '' : 's'} marked on ${'the page'}.`,
    )
    if (noted.length) {
      parts.push(
        noted.map((a) => `(${a.index ?? '?'}) ${shorten(a.note!, 70)} [on ${annotationWhere(a)}]`).join('; '),
      )
    } else if (n) {
      parts.push(annotations.map((a) => `(${a.index ?? '?'}) ${a.type} on ${annotationWhere(a)}`).join('; '))
    }
  }

  if (deadClicks.length) {
    parts.push(
      `${deadClicks.length} dead/no-response click${deadClicks.length === 1 ? '' : 's'} detected — verify the control(s) still work.`,
    )
  }
  return parts.join(' ')
}

/**
 * Soft mismatch check (#3): if the note references a name/label/title but the
 * selected element reads like a time or bare number, the mark probably landed
 * on the wrong element. Surface it so the agent asks instead of guessing.
 */
function noteElementMismatch(note: string | undefined, block: ElementBlock | undefined): string | undefined {
  if (!note || !block?.text) return undefined
  const n = note.toLowerCase()
  const txt = block.text.trim()
  if (!txt) return undefined
  const mentionsName = /\b(name|title|label|heading|caption)\b/.test(n)
  const looksTime = /\b\d{1,2}:\d{2}\b/.test(txt)
  const looksNumericOnly = /\d/.test(txt) && /^[\s\d.,:/–—-]+$/.test(txt)
  if (mentionsName && (looksTime || looksNumericOnly)) {
    return `Note mentions a name/label, but the selected element reads "${shorten(txt, 40)}" (looks like a time/number). Confirm the intended target before editing.`
  }
  return undefined
}

function summarizeWarnings(warnings: ConsoleEvent[]): string {
  const seen = new Map<string, number>()
  for (const w of warnings) {
    const k = normalizeMsg(w.text)
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const rep = shorten(warnings[0].text.replace(/\s+/g, ' ').trim(), 100)
  const distinctNote = seen.size > 1 ? ` (${seen.size} distinct)` : ''
  return `${warnings.length} console warning${warnings.length > 1 ? 's' : ''}${distinctNote}: ${rep}`
}

function shorten(s: string, max = 80): string {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/**
 * Keep one inline asset from dominating the bundle: replace data:/blob: URIs
 * with a tiny descriptor and truncate any absurdly long URL. Zero diagnostic
 * value is lost — the length is preserved for reference.
 */
const MAX_URL = 2000
const EXTENSION_ORIGIN = /(chrome-extension|moz-extension):\/\//i

/** An event that came from an extension (this recorder OR another one the user
 * has installed — axe, React DevTools, Grammarly…), not the app under test. */
function isRecorderNoise(e: CaptureEvent): boolean {
  // Browser logs emitted by an extension script (e.g. axe's inspector.js
  // "unload not allowed" violation) — kind 'log' isn't covered below.
  if (e.kind === 'log') return !!e.url && EXTENSION_ORIGIN.test(e.url)
  // Network requests fired by another extension (initiator is an extension
  // script) — a normal https URL, so only the initiator gives it away.
  if (e.kind === 'network') return !!e.initiator && EXTENSION_ORIGIN.test(e.initiator)
  if (e.kind !== 'error' && e.kind !== 'console') return false
  if (e.url && EXTENSION_ORIGIN.test(e.url)) return true
  if (e.stack && EXTENSION_ORIGIN.test(e.stack)) return true
  if ('stackFrames' in e && e.stackFrames?.some((f) => f.url && EXTENSION_ORIGIN.test(f.url)))
    return true
  return false
}

function stubUrl(url: string): string {
  if (!url) return url
  const dataMatch = url.match(/^data:([^;,]*)/i)
  if (dataMatch) return `data:${dataMatch[1] || ''};base64,<len=${url.length}>`
  if (/^blob:/i.test(url)) return `blob:<inline, len=${url.length}>`
  if (url.length > MAX_URL) return `${url.slice(0, 200)}…<truncated, len=${url.length}>`
  return url
}
