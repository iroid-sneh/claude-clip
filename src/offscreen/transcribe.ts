// ─────────────────────────────────────────────────────────────────────────
// Narration transcription (opt-in). Uses the browser's Web Speech API to turn
// spoken narration into timestamped text so the consumer can READ what the
// user said (Claude can't listen to audio).
//
// Privacy note: Chrome's SpeechRecognition routes audio through an online
// service — that's why this is opt-in and off by default (see the popup).
// ─────────────────────────────────────────────────────────────────────────

import type { TranscriptSegment } from '@/shared/types'

export class Transcriber {
  private recognition: any = null
  private segments: TranscriptSegment[] = []
  private startEpoch = 0
  private lastEndMs = 0
  private stopped = false
  private pendingInterim = '' // latest not-yet-final text, flushed on stop

  /** Returns true if it started; false if the API is unavailable. */
  start(startEpoch: number): boolean {
    const SR = (self as any).SpeechRecognition || (self as any).webkitSpeechRecognition
    if (!SR) return false
    this.startEpoch = startEpoch
    this.segments = []
    this.lastEndMs = 0
    this.stopped = false

    let rec: any
    try {
      rec = new SR()
    } catch {
      return false
    }
    rec.continuous = true
    // Interim results let us flush the trailing partial when recording stops,
    // so the last sentence isn't dropped mid-word.
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'

    rec.onresult = (e: any) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const text = String(r[0]?.transcript ?? '').trim()
        if (!text) continue
        if (r.isFinal) {
          const tEndMs = Date.now() - this.startEpoch
          const tStartMs = Math.max(this.lastEndMs, tEndMs - estimateMs(text))
          this.segments.push({ tStartMs, tEndMs, text })
          this.lastEndMs = tEndMs
          this.pendingInterim = ''
        } else {
          interim = text
        }
      }
      if (interim) this.pendingInterim = interim
    }
    // SpeechRecognition stops itself after a pause — restart to stay continuous.
    rec.onend = () => {
      if (!this.stopped) {
        try {
          rec.start()
        } catch {
          /* already starting */
        }
      }
    }
    rec.onerror = () => {}

    try {
      rec.start()
    } catch {
      return false
    }
    this.recognition = rec
    return true
  }

  stop(): TranscriptSegment[] {
    this.stopped = true
    // Flush the trailing partial the API would otherwise drop on stop.
    const tail = this.pendingInterim.trim()
    if (tail) {
      const tEndMs = Date.now() - this.startEpoch
      this.segments.push({
        tStartMs: Math.max(this.lastEndMs, tEndMs - estimateMs(tail)),
        tEndMs,
        text: tail,
      })
      this.pendingInterim = ''
    }
    try {
      this.recognition?.stop()
    } catch {
      /* ignore */
    }
    this.recognition = null
    return this.segments
  }
}

/** Rough spoken duration for a phrase (~400ms/word) to place a start time. */
function estimateMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.min(15000, Math.max(600, words * 400))
}
