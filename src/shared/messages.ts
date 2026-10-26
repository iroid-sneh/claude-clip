// ─────────────────────────────────────────────────────────────────────────
// Typed message contract between popup ↔ background ↔ content script.
// One request/response envelope keeps the RPC surface small and safe.
// ─────────────────────────────────────────────────────────────────────────

import type {
  Annotation,
  CaptureCounts,
  CaptureEvent,
  InteractionEvent,
  KeyframeSpec,
  RecordingStatus,
  SessionSummary,
  TranscriptSegment,
} from './types'

export type Msg =
  | { type: 'START_RECORDING'; mic?: boolean; transcribe?: boolean }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_STATE' }
  | { type: 'EXPORT_BUNDLE'; id?: string }
  | { type: 'GET_HISTORY' }
  | { type: 'DELETE_SESSION'; id: string }
  // content → background: an annotation was drawn on the page overlay
  | { type: 'ADD_ANNOTATION'; annotation: Annotation }
  // content → background: an annotation was undone / all cleared
  | { type: 'REMOVE_ANNOTATION'; id: string }
  | { type: 'CLEAR_ANNOTATIONS' }
  // content → background: a user interaction (click/input/scroll/nav)
  | { type: 'ADD_INTERACTION'; event: InteractionEvent }
  // content → background: a page-hook error / console event
  | { type: 'ADD_EVENT'; event: CaptureEvent }
  // background → content: capture a DOM accessibility snapshot now (on error)
  | { type: 'SNAPSHOT_DOM'; reason: string }
  // content → background: capture the visible tab (for an annotation region crop)
  | { type: 'CAPTURE_VISIBLE' }
  // background → content: toggle overlay + interaction tracking on/off.
  // startEpoch is the recording origin so tMs stays consistent across pages.
  | { type: 'SET_OVERLAY'; active: boolean; startEpoch?: number }
  // content → background: a page loaded; ask whether recording is active here
  | { type: 'CONTENT_READY' }
  // background → offscreen: start/stop MediaRecorder capture
  | { type: 'OFFSCREEN_START'; sessionId: string; streamId: string; mic: boolean; transcribe: boolean }
  | { type: 'OFFSCREEN_STOP' }
  // offscreen → background: capture finished / failed
  | {
      type: 'MEDIA_DONE'
      sessionId: string
      ok: boolean
      hasAudio: boolean
      error?: string
      transcript?: TranscriptSegment[]
    }
  // background → offscreen: extract keyframes from the saved video
  | { type: 'EXTRACT_FRAMES'; sessionId: string; specs: KeyframeSpec[] }
  // offscreen → background: keyframe extraction finished / failed
  | { type: 'FRAMES_DONE'; sessionId: string; ok: boolean; count: number; error?: string }

export interface StateResponse {
  status: RecordingStatus
  counts: CaptureCounts
  durationMs: number
  tabId?: number
  url?: string
  attachError?: string
  sessionId?: string
  hasVideo: boolean
  micActive: boolean
  frameCount: number
  needsPageReload: boolean
}

export interface ExportResponse {
  ok: boolean
  filename?: string
  error?: string
}

export interface HistoryResponse {
  sessions: SessionSummary[]
}

export interface AckResponse {
  ok: boolean
  error?: string
}

export interface SnapshotResponse {
  ok: boolean
  tree?: string
  url?: string
}

/** Reply to CONTENT_READY: is recording active on this tab, and since when. */
export interface ContentReadyResponse {
  ok: boolean
  active: boolean
  startEpoch?: number
}

export type MsgResponse = StateResponse | ExportResponse | AckResponse | { ok: boolean }

export function sendToBackground<T = MsgResponse>(msg: Msg): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>
}
