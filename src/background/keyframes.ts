// ─────────────────────────────────────────────────────────────────────────
// Keyframe selection — decide WHICH moments of the recording become images.
//
// Strategy (PLAN.md §3, event-boundary sampling): sample a frame at each
// significant boundary rather than on a fixed interval, because ~6–15
// well-chosen frames beat 100 uniform ones for both the image cap and the
// model's attention budget. Around each error we also grab the last "good"
// frame before it — the single most diagnostic before/after comparison.
// ─────────────────────────────────────────────────────────────────────────

import type { KeyframeSpec, Session } from '@/shared/types'
import { isTrackingNoise } from './noise'

const MAX_FRAMES = 14
const DEDUP_MS = 450 // collapse frames closer than this
const BEFORE_ERROR_MS = 700 // "last good" frame offset before an error

interface Candidate {
  tMs: number
  caption: string
  trigger: string
  priority: number // higher = more important to keep when trimming
}

export function pickKeyframes(session: Session): KeyframeSpec[] {
  const dur = Math.max(session.durationMs, 1)
  const candidates: Candidate[] = []
  // Route over time, so each frame can be stamped with the URL of its moment.
  const navPoints: { tMs: number; url?: string }[] = [{ tMs: 0, url: session.meta.url }]
  const viewport = session.meta.viewport

  // Always anchor the start and end for context.
  candidates.push({ tMs: 0, caption: 'Recording start', trigger: 'context', priority: 1 })
  candidates.push({ tMs: dur, caption: 'Final state', trigger: 'context', priority: 1 })

  for (const e of session.events) {
    if (e.kind === 'error') {
      candidates.push({
        tMs: Math.max(0, e.tMs - BEFORE_ERROR_MS),
        caption: `Just before: ${e.exceptionType}`,
        trigger: 'error',
        priority: 4,
      })
      candidates.push({
        tMs: e.tMs,
        caption: `${e.exceptionType}: ${trim(e.message, 70)}`,
        trigger: 'error',
        priority: 6,
      })
    } else if (
      e.kind === 'network' &&
      (e.failed || (e.status ?? 0) >= 400) &&
      !isTrackingNoise(e.url) // don't spend keyframes on blocked analytics beacons
    ) {
      candidates.push({
        tMs: e.tMs,
        caption: `${e.method} ${host(e.url)} → ${e.failed ? e.errorText ?? 'failed' : e.status}`,
        trigger: 'network',
        priority: 5,
      })
    } else if (e.kind === 'interaction' && e.action === 'navigation') {
      navPoints.push({ tMs: e.tMs, url: e.url })
      candidates.push({
        tMs: e.tMs,
        caption: `Navigate → ${e.url ? host(e.url) : 'page'}`,
        trigger: 'nav',
        priority: 4,
      })
    } else if (e.kind === 'interaction' && e.action === 'click') {
      const who = e.element?.component ? `<${e.element.component}> ${e.label ?? ''}` : e.label ?? e.target ?? 'element'
      const tag = e.rage ? ' [RAGE]' : e.dead ? ' [DEAD]' : ''
      candidates.push({
        tMs: e.tMs,
        caption: `Click ${trim(who, 56)}${tag}`,
        trigger: 'click',
        priority: e.rage || e.dead ? 5 : 3,
      })
    } else if (e.kind === 'dom') {
      candidates.push({ tMs: e.tMs, caption: `DOM change (${e.reason})`, trigger: 'dom', priority: 4 })
    }
  }

  for (const a of session.annotations) {
    candidates.push({
      tMs: a.tMs,
      caption: a.note
        ? trim(a.note, 70)
        : `Drew ${a.type}${a.target?.component ? ` on <${a.target.component}>` : ''}`,
      trigger: 'annotation',
      priority: 6,
    })
  }

  // Only if there's genuinely little signal, add a couple context frames.
  if (candidates.length < 4) {
    for (const frac of [0.33, 0.66]) {
      candidates.push({
        tMs: Math.round(dur * frac),
        caption: `Context (${Math.round(frac * 100)}%)`,
        trigger: 'context',
        priority: 2,
      })
    }
  }

  return finalize(candidates, dur, navPoints, viewport)
}

function finalize(
  candidates: Candidate[],
  dur: number,
  navPoints: { tMs: number; url?: string }[],
  viewport?: { w: number; h: number },
): KeyframeSpec[] {
  // Sort by time, then collapse near-duplicates keeping the higher priority.
  candidates.sort((a, b) => a.tMs - b.tMs)
  const merged: Candidate[] = []
  for (const c of candidates) {
    const prev = merged[merged.length - 1]
    if (prev && Math.abs(prev.tMs - c.tMs) < DEDUP_MS) {
      if (c.priority > prev.priority) merged[merged.length - 1] = c
    } else {
      merged.push(c)
    }
  }

  // If still over budget, drop the lowest-priority (context) frames first.
  let kept = merged
  if (kept.length > MAX_FRAMES) {
    const ranked = [...merged].sort((a, b) => b.priority - a.priority).slice(0, MAX_FRAMES)
    const keepSet = new Set(ranked)
    kept = merged.filter((c) => keepSet.has(c))
  }

  return kept.map((c, i) => {
    const tMs = Math.min(c.tMs, dur)
    // URL in effect at this moment = last navigation at/before it.
    let url = navPoints[0]?.url
    for (const n of navPoints) if (n.tMs <= tMs && n.url) url = n.url
    return {
      tMs,
      label: `Image ${i + 1}`,
      caption: c.caption,
      trigger: c.trigger,
      url,
      viewport,
    }
  })
}

function trim(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function host(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
