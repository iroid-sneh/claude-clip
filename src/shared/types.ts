// ─────────────────────────────────────────────────────────────────────────
// Claude Clip — shared type definitions
// The capture model that becomes agent-context.json (see PLAN.md §7).
// Every captured event is timestamped relative to record start (tMs) and,
// where possible, carries a causal pointer so Claude can follow the chain
// click → request → error → broken pixel.
// ─────────────────────────────────────────────────────────────────────────

export type RecordingStatus = 'idle' | 'recording' | 'stopping' | 'error'

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'

/** One resolved frame of a call stack. */
export interface StackFrame {
  function?: string
  url?: string
  line?: number
  column?: number
}

/** A console.* call captured via Runtime.consoleAPICalled. */
export interface ConsoleEvent {
  id: string
  kind: 'console'
  tMs: number
  level: ConsoleLevel
  text: string
  /** Structured argument previews (objects survive as inspectable text). */
  args?: string[]
  stack?: string
  stackFrames?: StackFrame[]
  url?: string
  line?: number
  /** Captured by the page-context hook (not CDP) — used for de-duplication. */
  pageHook?: boolean
}

/** An uncaught exception / unhandled rejection via Runtime.exceptionThrown. */
export interface ErrorEvent {
  id: string
  kind: 'error'
  tMs: number
  exceptionType: string
  message: string
  stack?: string
  stackFrames?: StackFrame[]
  url?: string
  line?: number
  column?: number
  /** id of the network event this error is correlated with, if any. */
  relatedNetwork?: string
  /** Captured by the page-context hook (not CDP) — used for de-duplication. */
  pageHook?: boolean
}

/** A browser-internal Log.entryAdded entry (CORS/CSP/deprecation/security). */
export interface BrowserLogEvent {
  id: string
  kind: 'log'
  tMs: number
  source: string
  level: string
  text: string
  url?: string
  category?: string
  networkRequestId?: string
}

/** A network request/response captured across the CDP Network lifecycle. */
export interface NetworkEvent {
  id: string
  kind: 'network'
  requestId: string
  tMs: number
  method: string
  url: string
  status?: number
  statusText?: string
  mimeType?: string
  resourceType?: string
  durationMs?: number
  requestHeaders?: Record<string, string>
  requestBody?: string
  responseHeaders?: Record<string, string>
  responseBody?: string
  responseBodyTruncated?: boolean
  fromCache?: boolean
  failed?: boolean
  errorText?: string
  blockedReason?: string
  corsError?: string
  remoteIP?: string
  sizeBytes?: number
  ttfbMs?: number
  initiator?: string
  /** Response claimed JSON but did not parse — the body is kept in full. */
  malformed?: boolean
}

/** Stable identity of a DOM element the user interacted with or annotated. */
export interface ElementInfo {
  tag?: string
  selector?: string
  /** data-testid / data-test — the most stable hook when present. */
  testid?: string
  elementId?: string
  ariaLabel?: string
  role?: string
  text?: string
  /** A readable DOM path from an ancestor down to the element. */
  domPath?: string
  rect?: { x: number; y: number; w: number; h: number }
  /** React/Vue component name (resolved in the page's MAIN world). */
  component?: string
}

export type InteractionAction =
  | 'click'
  | 'input'
  | 'submit'
  | 'scroll'
  | 'navigation'
  | 'keydown'

/** A user interaction captured in the page (content script). */
export interface InteractionEvent {
  id: string
  kind: 'interaction'
  tMs: number
  action: InteractionAction
  target?: string // robust CSS-ish selector
  label?: string // visible text / aria-label
  value?: string // masked input value
  url?: string
  x?: number
  y?: number
  /** ≥3 clicks on the same target in a short window — user frustration. */
  rage?: boolean
  /** A click that produced no DOM change / navigation — likely broken handler. */
  dead?: boolean
  /** Full stable identity of the interacted element. */
  element?: ElementInfo
}

/** A compact accessibility snapshot of the DOM, captured at an error moment. */
export interface DomSnapshotEvent {
  id: string
  kind: 'dom'
  tMs: number
  reason: string
  url?: string
  tree: string
}

export type CaptureEvent =
  | ConsoleEvent
  | ErrorEvent
  | BrowserLogEvent
  | NetworkEvent
  | InteractionEvent
  | DomSnapshotEvent

/** One transcribed span of spoken narration, timed to recording start. */
export interface TranscriptSegment {
  tStartMs: number
  tEndMs: number
  text: string
}

export interface EnvironmentMeta {
  url?: string
  title?: string
  userAgent?: string
  viewport?: { w: number; h: number }
  dpr?: number
  connection?: string
  locale?: string
  timezone?: string
  browser?: string
  os?: string
  framework?: string
  frameworkVersion?: string
}

/** Lightweight summary of a stored session for the history list. */
export interface SessionSummary {
  id: string
  startedAt: number
  durationMs: number
  url?: string
  title?: string
  counts: CaptureCounts
  hasVideo: boolean
  frameCount: number
}

/** Live counters surfaced in the popup while recording. */
export interface CaptureCounts {
  network: number
  networkFailed: number
  console: number
  errors: number
  logs: number
  annotations: number
  interactions: number
}

/** The full in-flight recording session persisted to IndexedDB. */
export interface Session {
  id: string
  status: RecordingStatus
  tabId: number
  startedAt: number // epoch ms
  durationMs: number
  meta: EnvironmentMeta
  events: CaptureEvent[]
  annotations: Annotation[]
  attachError?: string
  /** Whether a video track was recorded for this session. */
  hasVideo?: boolean
  /** Whether the recorded video carries an audio track (tab and/or mic). */
  hasAudio?: boolean
  /** Whether the user requested mic capture for this session. */
  micRequested?: boolean
  /** Number of keyframes extracted into the storyboard. */
  frameCount?: number
  /** Whether transcription of narration was requested. */
  transcribeRequested?: boolean
  /** Transcribed narration segments (opt-in). */
  transcript?: TranscriptSegment[]
}

// ── Keyframe storyboard (Phase 3) ─────────────────────────────────────────
// Claude cannot read video, so the recording is reduced to labeled frames
// sampled at event boundaries (PLAN.md §7). Each is timestamped and captioned
// so the JSON timeline can reference it by label ("Image 3").

export interface KeyframeSpec {
  tMs: number
  label: string // "Image 1", "Image 2", …
  caption: string
  trigger: string // 'error' | 'network' | 'annotation' | 'click' | 'nav' | 'context'
  /** URL + viewport at this frame's moment, so route/orientation changes show. */
  url?: string
  viewport?: { w: number; h: number }
}

export interface FrameRecord extends KeyframeSpec {
  id: string
  /** JPEG data URL of the captured frame. */
  dataUrl: string
  w: number
  h: number
}

export interface FrameBundle {
  id: string // sessionId
  frames: FrameRecord[]
  /** A single contact-sheet PNG (all frames + captions) Claude can read at once. */
  storyboard?: string
  createdAt: number
}

// ── Drawing / annotation model (Excalidraw-style overlay) ─────────────────

export type ToolKind =
  | 'pen'
  | 'arrow'
  | 'rectangle'
  | 'ellipse'
  | 'highlighter'
  | 'eraser'
  | 'text'

export interface Annotation {
  id: string
  tMs: number
  type: ToolKind
  /** Flattened point list [x0,y0,x1,y1,...] in page coordinates. */
  points: number[]
  color: string
  strokeWidth: number
  note?: string
  /** 1-based mark number, shown as a badge on the page and in the bundle. */
  index?: number
  /** The element the mark points at / encircles. */
  target?: ElementInfo
  /** Snapshot of that element at annotation time. */
  outerHTML?: string
  styles?: Record<string, string>
  /** URL + viewport when the mark was drawn. */
  url?: string
  viewport?: { w: number; h: number }
  /** JPEG data URL of the marked region (shape + note + underlying UI) so the
   * consumer can SEE what was marked. Written to the .clip as an image file. */
  image?: string
}
