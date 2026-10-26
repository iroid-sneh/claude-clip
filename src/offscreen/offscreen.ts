// ─────────────────────────────────────────────────────────────────────────
// Offscreen recorder. The MV3 service worker has no DOM, so tab capture,
// audio mixing, and MediaRecorder all run here. Driven by messages:
//   OFFSCREEN_START { streamId, mic } → begin recording
//   OFFSCREEN_STOP                    → finalize, persist blob, report back
//
// Audio path: tab audio is mixed with an optional mic into one track via an
// AudioContext, and the tab audio is ALSO routed to the speakers so the user
// still hears the page while it's being captured.
// ─────────────────────────────────────────────────────────────────────────

import { saveVideo } from '@/background/store'
import { extractFrames } from './frames'
import { Transcriber } from './transcribe'
import type { Msg } from '@/shared/messages'
import type { TranscriptSegment } from '@/shared/types'

interface ActiveCapture {
  sessionId: string
  recorder: MediaRecorder
  chunks: Blob[]
  mimeType: string
  hasAudio: boolean
  startedAt: number
  tabStream: MediaStream
  micStream?: MediaStream
  audioCtx?: AudioContext
  transcriber?: Transcriber
}

let active: ActiveCapture | null = null

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return 'video/webm'
}

async function startCapture(
  sessionId: string,
  streamId: string,
  mic: boolean,
  transcribe: boolean,
): Promise<{ hasAudio: boolean }> {
  // Legacy mandatory constraints are still the tabCapture contract in Chrome.
  const tabStream = await navigator.mediaDevices.getUserMedia({
    video: {
      // @ts-expect-error — chromeMediaSource is a Chrome-only constraint
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    audio: {
      // @ts-expect-error — chromeMediaSource is a Chrome-only constraint
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  })

  const videoTracks = tabStream.getVideoTracks()
  const tabAudioTracks = tabStream.getAudioTracks()

  let micStream: MediaStream | undefined
  if (mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      // Mic denied/unavailable — continue with tab audio only.
      micStream = undefined
    }
  }

  // Mix tab audio + mic into a single destination track.
  let mixedAudioTrack: MediaStreamTrack | undefined
  let audioCtx: AudioContext | undefined
  const sources = [
    ...(tabAudioTracks.length ? [new MediaStream(tabAudioTracks)] : []),
    ...(micStream ? [micStream] : []),
  ]
  if (sources.length) {
    audioCtx = new AudioContext()
    const dest = audioCtx.createMediaStreamDestination()
    for (const s of sources) {
      const node = audioCtx.createMediaStreamSource(s)
      node.connect(dest)
    }
    // Route tab audio back to the speakers so playback isn't silenced.
    if (tabAudioTracks.length) {
      audioCtx.createMediaStreamSource(new MediaStream(tabAudioTracks)).connect(audioCtx.destination)
    }
    mixedAudioTrack = dest.stream.getAudioTracks()[0]
  }

  const finalStream = new MediaStream([
    ...videoTracks,
    ...(mixedAudioTrack ? [mixedAudioTrack] : []),
  ])

  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(finalStream, { mimeType, videoBitsPerSecond: 4_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  const startedAt = Date.now()

  // Opt-in narration transcription (needs mic).
  let transcriber: Transcriber | undefined
  if (transcribe && mic) {
    transcriber = new Transcriber()
    if (!transcriber.start(startedAt)) transcriber = undefined
  }

  active = {
    sessionId,
    recorder,
    chunks,
    mimeType,
    hasAudio: !!mixedAudioTrack,
    startedAt,
    tabStream,
    micStream,
    audioCtx,
    transcriber,
  }

  // If the user stops sharing via Chrome's own control, end gracefully.
  videoTracks[0]?.addEventListener('ended', () => void stopCapture())

  recorder.start(1000) // emit a chunk each second so long recordings stay safe
  return { hasAudio: !!mixedAudioTrack }
}

async function stopCapture(): Promise<void> {
  const cap = active
  if (!cap) return
  active = null

  const transcript = cap.transcriber?.stop()

  await new Promise<void>((resolve) => {
    cap.recorder.onstop = () => resolve()
    if (cap.recorder.state !== 'inactive') cap.recorder.stop()
    else resolve()
  })

  // Release hardware/tab locks.
  cap.tabStream.getTracks().forEach((t) => t.stop())
  cap.micStream?.getTracks().forEach((t) => t.stop())
  await cap.audioCtx?.close().catch(() => {})

  const blob = new Blob(cap.chunks, { type: cap.mimeType })
  const durationMs = Date.now() - cap.startedAt

  try {
    await saveVideo({
      id: cap.sessionId,
      blob,
      mimeType: cap.mimeType,
      durationMs,
      hasAudio: cap.hasAudio,
      createdAt: Date.now(),
    })
    report(cap.sessionId, true, cap.hasAudio, undefined, transcript)
  } catch (err) {
    report(cap.sessionId, false, cap.hasAudio, (err as Error).message, transcript)
  }
}

function report(
  sessionId: string,
  ok: boolean,
  hasAudio: boolean,
  error?: string,
  transcript?: TranscriptSegment[],
): void {
  chrome.runtime
    .sendMessage({ type: 'MEDIA_DONE', sessionId, ok, hasAudio, error, transcript } satisfies Msg)
    .catch(() => {})
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START') {
    startCapture(msg.sessionId, msg.streamId, msg.mic, msg.transcribe)
      .then((r) => sendResponse({ ok: true, hasAudio: r.hasAudio }))
      .catch((err) => {
        active = null
        report(msg.sessionId, false, false, (err as Error).message)
        sendResponse({ ok: false, error: (err as Error).message })
      })
    return true
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  if (msg.type === 'EXTRACT_FRAMES') {
    extractFrames(msg.sessionId, msg.specs)
      .then((count) => {
        chrome.runtime
          .sendMessage({ type: 'FRAMES_DONE', sessionId: msg.sessionId, ok: true, count } satisfies Msg)
          .catch(() => {})
        sendResponse({ ok: true })
      })
      .catch((err) => {
        chrome.runtime
          .sendMessage({
            type: 'FRAMES_DONE',
            sessionId: msg.sessionId,
            ok: false,
            count: 0,
            error: (err as Error).message,
          } satisfies Msg)
          .catch(() => {})
        sendResponse({ ok: false, error: (err as Error).message })
      })
    return true
  }
  return false
})
