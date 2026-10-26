// ─────────────────────────────────────────────────────────────────────────
// Keyframe extraction + storyboard composition (Phase 3).
//
// Runs in the offscreen document because it needs a real <video>/<canvas>.
// For each keyframe timestamp it seeks the recorded .webm and grabs a JPEG,
// then stacks them into ONE contact-sheet PNG with captions — a single image
// Claude can read to "watch" the bug (since the API has no video input).
// ─────────────────────────────────────────────────────────────────────────

import { loadVideo, saveFrames } from '@/background/store'
import type { FrameBundle, FrameRecord, KeyframeSpec } from '@/shared/types'

const MAX_EDGE = 1568 // Claude's standard-tier long-edge cap; keeps text legible
const JPEG_QUALITY = 0.82
const SHEET_W = 760
const SHEET_PAD = 12
const CAPTION_H = 30
const CELL_MAX_H = 380

export async function extractFrames(
  sessionId: string,
  specs: KeyframeSpec[],
): Promise<number> {
  const rec = await loadVideo(sessionId)
  if (!rec) throw new Error('No recorded video for this session.')

  const url = URL.createObjectURL(rec.blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url

  try {
    await once(video, 'loadedmetadata')
    const duration = await resolveDuration(video, rec.durationMs / 1000)

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    const frames: FrameRecord[] = []
    for (const spec of specs) {
      const t = clamp(spec.tMs / 1000, 0, Math.max(0, duration - 0.05))
      try {
        await seek(video, t)
        // 'seeked' fires before the new frame is painted — wait for an actual
        // decoded frame or a paint tick, else we capture a black frame.
        await frameReady(video)
        const { dataUrl, w, h } = grab(video, canvas, ctx)
        frames.push({ ...spec, id: `${sessionId}_${spec.label.replace(/\s+/g, '')}`, dataUrl, w, h })
      } catch {
        // Skip a frame that fails to seek/capture rather than aborting all.
      }
    }

    const storyboard = frames.length ? await composeStoryboard(frames) : undefined
    const bundle: FrameBundle = { id: sessionId, frames, storyboard, createdAt: Date.now() }
    await saveFrames(bundle)
    return frames.length
  } finally {
    video.src = ''
    URL.revokeObjectURL(url)
  }
}

// ── video helpers ─────────────────────────────────────────────────────────

function once(el: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      cleanup()
      resolve()
    }
    const err = () => {
      cleanup()
      reject(new Error(`video ${event} failed`))
    }
    const cleanup = () => {
      el.removeEventListener(event, ok)
      el.removeEventListener('error', err)
    }
    el.addEventListener(event, ok, { once: true })
    el.addEventListener('error', err, { once: true })
  })
}

/**
 * MediaRecorder WebM often reports duration = Infinity until fully scanned.
 * Force a resolve by seeking to a huge time, then fall back to the recorder's
 * measured duration.
 */
async function resolveDuration(video: HTMLVideoElement, fallback: number): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (Number.isFinite(video.duration)) {
        video.removeEventListener('durationchange', onChange)
        resolve()
      }
    }
    video.addEventListener('durationchange', onChange)
    video.currentTime = 1e7
    setTimeout(resolve, 800)
  })
  video.currentTime = 0
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallback
}

/**
 * Wait until the decoder has actually presented the frame at the current time.
 * requestVideoFrameCallback fires when a new frame is available for display;
 * fall back to a double rAF + short delay for browsers without it.
 */
function frameReady(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const anyVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    if (typeof anyVideo.requestVideoFrameCallback === 'function') {
      anyVideo.requestVideoFrameCallback(() => finish())
      // Nudge the pipeline so a frame is presented even while paused.
      video.play().then(() => video.pause()).catch(() => {})
      setTimeout(finish, 400) // safety net
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 60)))
    }
  })
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
    const timer = setTimeout(() => {
      video.removeEventListener('seeked', onSeeked)
      reject(new Error('seek timeout'))
    }, 2500)
    video.addEventListener('seeked', onSeeked)
    video.currentTime = t
  })
}

function grab(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { dataUrl: string; w: number; h: number } {
  const vw = video.videoWidth || 1280
  const vh = video.videoHeight || 720
  const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh))
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)
  canvas.width = w
  canvas.height = h
  ctx.drawImage(video, 0, 0, w, h)
  return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), w, h }
}

// ── storyboard contact sheet ────────────────────────────────────────────────

async function composeStoryboard(frames: FrameRecord[]): Promise<string> {
  const imgW = SHEET_W - SHEET_PAD * 2

  // Decode every frame image up front so drawImage is synchronous below.
  const cells = await Promise.all(
    frames.map(async (f) => {
      const img = await decodeImage(f.dataUrl)
      const h = Math.min(CELL_MAX_H, Math.round((f.h / f.w) * imgW))
      return { f, img, h }
    }),
  )

  const totalH = SHEET_PAD + cells.reduce((sum, c) => sum + CAPTION_H + c.h + SHEET_PAD, 0)

  const canvas = document.createElement('canvas')
  canvas.width = SHEET_W
  canvas.height = totalH
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#0b0b0f'
  ctx.fillRect(0, 0, SHEET_W, totalH)

  let y = SHEET_PAD
  for (const { f, img, h } of cells) {
    // caption bar (colored by what triggered the frame)
    ctx.fillStyle = triggerColor(f.trigger)
    ctx.fillRect(SHEET_PAD, y, imgW, CAPTION_H)
    ctx.fillStyle = '#0b0b0f'
    ctx.font = '600 13px -apple-system, Segoe UI, sans-serif'
    ctx.textBaseline = 'middle'
    const t = (f.tMs / 1000).toFixed(1)
    ctx.fillText(`${f.label} · ${t}s · ${f.caption}`, SHEET_PAD + 10, y + CAPTION_H / 2, imgW - 20)
    y += CAPTION_H

    // frame image
    ctx.drawImage(img, SHEET_PAD, y, imgW, h)
    y += h + SHEET_PAD
  }

  return canvas.toDataURL('image/png')
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('frame decode failed'))
    img.src = dataUrl
  })
}

function triggerColor(trigger: string): string {
  switch (trigger) {
    case 'error':
      return '#ff6b62'
    case 'network':
      return '#ffb340'
    case 'annotation':
      return '#d97757'
    default:
      return '#8e8e93'
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
