import { useCallback, useEffect, useRef, useState } from 'react'
import { zipSync, strToU8 } from 'fflate'
import { sendToBackground } from '@/shared/messages'
import type {
  AckResponse,
  ExportResponse,
  HistoryResponse,
  StateResponse,
} from '@/shared/messages'
import type { CaptureCounts, RecordingStatus, SessionSummary } from '@/shared/types'
import { loadFrames, loadSession, loadVideo } from '@/background/store'
import type { FrameRecord } from '@/shared/types'
import { Sunburst } from './Sunburst'

// Baked in at build time from .env.production (see .env.example) so a team
// build uploads to the shared dev server. Unset → the Share button is hidden
// and clips stay on-device (Export .clip only).
const SHARE_ENABLED = !!import.meta.env.VITE_SHARE_URL
const SHARE_URL = String(import.meta.env.VITE_SHARE_URL || 'http://localhost:4747').replace(/\/+$/, '')
const SHARE_TOKEN = String(import.meta.env.VITE_SHARE_TOKEN || '')

const EMPTY_COUNTS: CaptureCounts = {
  network: 0,
  networkFailed: 0,
  console: 0,
  errors: 0,
  logs: 0,
  annotations: 0,
  interactions: 0,
}

const CLIP_FILES = `Files:
  agent-context.json  — correlated, redacted capture (read this)
  storyboard.png      — labeled keyframes at event boundaries (attach as image)
  annotations/        — a cropped image per drawn mark (shape + note + the UI it
                        points at); each annotation's "image" field names its file
  video.webm          — full screen recording (optional; Claude cannot read video)

Sensitive values were masked on-device before this file was created.
`

/**
 * The README mirrors the JSON's mode so the human's first-opened file doesn't
 * contradict it: a feedback clip must NOT say "diagnose the bug / start from
 * errors" when there are no errors.
 */
function buildReadme(mode?: string, brief?: string): string {
  const briefBlock = brief ? `\nWhat the user is asking for:\n  ${brief}\n` : ''
  if (mode === 'feedback') {
    return `Claude Clip feedback / change request
=====================================

This is a FEEDBACK clip — no errors or failed requests were recorded. The user
is requesting a change to behavior or appearance, not reporting a crash. Don't
hunt for an error that isn't there.

Drag agent-context.json (and storyboard.png / the annotations images) into
Claude. Start from "agent_brief" and "annotations" — the user's marks and notes
are the intent. The timeline and frames give context.
${briefBlock}
${CLIP_FILES}`
  }
  return `Claude Clip bug capture
=======================

Drag agent-context.json and storyboard.png into Claude and ask it to diagnose
the bug. The JSON's timeline references each storyboard frame by label
("Image N"). Start from "agent_brief", then "errors", correlate to
"network_detail" by id, and confirm the visual symptom against the storyboard.
${briefBlock}
${CLIP_FILES}`
}

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const buf = await (await fetch(dataUrl)).arrayBuffer()
  return new Uint8Array(buf)
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}

function fmtWhen(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function hostOf(url?: string): string | undefined {
  try {
    return url ? new URL(url).host : undefined
  } catch {
    return undefined
  }
}

export function Popup() {
  const [status, setStatus] = useState<RecordingStatus>('idle')
  const [counts, setCounts] = useState<CaptureCounts>(EMPTY_COUNTS)
  const [duration, setDuration] = useState(0)
  const [url, setUrl] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [mic, setMic] = useState(false)
  const [transcribe, setTranscribe] = useState(true) // on by default
  const [liveId, setLiveId] = useState<string | undefined>()
  const [frameCount, setFrameCount] = useState(0)
  const [needsReload, setNeedsReload] = useState(false)

  // review state
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [videoUrl, setVideoUrl] = useState<string | undefined>()
  const [frames, setFrames] = useState<FrameRecord[]>([])
  const [storyboard, setStoryboard] = useState<string | undefined>()
  const [shareUrl, setShareUrl] = useState<string | undefined>()
  const [exported, setExported] = useState(false)

  // history
  const [history, setHistory] = useState<SessionSummary[]>([])

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const videoUrlRef = useRef<string | undefined>()

  const recording = status === 'recording'
  const view: 'recording' | 'review' | 'home' = recording
    ? 'recording'
    : selectedId
      ? 'review'
      : 'home'

  const refresh = useCallback(async () => {
    const s = await sendToBackground<StateResponse>({ type: 'GET_STATE' })
    setStatus(s.status)
    setCounts(s.counts)
    setDuration(s.durationMs)
    setUrl(s.url)
    setLiveId(s.sessionId)
    setFrameCount(s.frameCount)
    setNeedsReload(s.needsPageReload)
    if (s.attachError) setError(s.attachError)
  }, [])

  const loadHistory = useCallback(async () => {
    const h = await sendToBackground<HistoryResponse>({ type: 'GET_HISTORY' })
    setHistory(h.sessions)
  }, [])

  useEffect(() => {
    void refresh()
    void loadHistory()
    // Restore the remembered mic preference (and re-sync with the actual
    // browser permission, which Chrome persists per extension origin).
    void (async () => {
      const { micEnabled, transcribeEnabled } = await chrome.storage.local.get([
        'micEnabled',
        'transcribeEnabled',
      ])
      let granted = false
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
        granted = status.state === 'granted'
      } catch {
        /* ignore */
      }
      setMic(!!micEnabled && granted)
      // Default ON unless the user explicitly turned it off before.
      setTranscribe(transcribeEnabled !== false)
    })()
    pollRef.current = setInterval(refresh, 500)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
    }
  }, [refresh, loadHistory])

  const loadPreview = useCallback(async (id: string) => {
    const rec = await loadVideo(id)
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current)
      videoUrlRef.current = undefined
    }
    if (rec) {
      const objUrl = URL.createObjectURL(rec.blob)
      videoUrlRef.current = objUrl
      setVideoUrl(objUrl)
    } else setVideoUrl(undefined)
    const fb = await loadFrames(id)
    setFrames(fb?.frames ?? [])
    setStoryboard(fb?.storyboard)
  }, [])

  // Load preview whenever a review target is chosen (and refresh as frames arrive).
  useEffect(() => {
    if (selectedId) void loadPreview(selectedId)
  }, [selectedId, frameCount, loadPreview])

  const openReview = (id: string) => {
    setError(undefined)
    setShareUrl(undefined)
    setExported(false)
    setSelectedId(id)
  }

  const goHome = () => {
    setSelectedId(undefined)
    setShareUrl(undefined)
    setExported(false)
    void loadHistory()
  }

  const requestMic = async (next: boolean) => {
    setError(undefined)
    if (!next) {
      setMic(false)
      await chrome.storage.local.set({ micEnabled: false })
      return
    }
    // Already granted for this extension origin? Just turn it on — no prompt.
    let state: PermissionState = 'prompt'
    try {
      const status = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      })
      state = status.state
    } catch {
      /* Firefox/older Chrome: fall through to the grant page */
    }
    if (state === 'granted') {
      setMic(true)
      await chrome.storage.local.set({ micEnabled: true, micGranted: true })
      return
    }
    // Not granted yet — open a real tab where Chrome can show the prompt
    // reliably (the popup closes when the prompt steals focus).
    setMic(true)
    await chrome.storage.local.set({ micEnabled: true })
    chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') })
  }

  // Ask for access to THIS site at record time, per-domain, from the popup's
  // user gesture — Chrome shows a one-time "Allow Claude Clip on example.com?"
  // prompt instead of granting every site at install. (The `debugger` permission
  // itself is required at install — Chrome won't allow it to be optional.)
  const ensureCapturePermission = async (): Promise<{ ok: boolean; error?: string }> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url
    if (!url) return { ok: false, error: 'No active tab to record.' }
    if (/^(chrome|edge|about|chrome-extension|devtools|view-source|file):/i.test(url)) {
      return { ok: false, error: 'Cannot record browser-internal, extension, or local-file pages.' }
    }
    let origin: string
    try {
      origin = new URL(url).origin + '/*'
    } catch {
      return { ok: false, error: 'This page URL is not supported.' }
    }
    const need: chrome.permissions.Permissions = { origins: [origin] }
    if (await chrome.permissions.contains(need)) return { ok: true }
    let granted = false
    try {
      granted = await chrome.permissions.request(need)
    } catch {
      // The prompt can close the popup; the grant may still have landed.
      return { ok: false, error: 'Permission prompt was interrupted — click Record again to continue.' }
    }
    if (!granted) {
      return {
        ok: false,
        error: 'Claude Clip needs access to this site to capture the bug. Click Record and choose Allow.',
      }
    }
    return { ok: true }
  }

  const onStart = async () => {
    setBusy(true)
    setError(undefined)
    setSelectedId(undefined)
    try {
      const perm = await ensureCapturePermission()
      if (!perm.ok) {
        setError(perm.error)
        return
      }
      const res = await sendToBackground<AckResponse>({
        type: 'START_RECORDING',
        mic,
        transcribe: transcribe && mic,
      })
      if (!res.ok) setError(res.error)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const onStop = async () => {
    setBusy(true)
    try {
      await sendToBackground<AckResponse>({ type: 'STOP_RECORDING' })
      await refresh()
      await loadHistory()
      if (liveId) openReview(liveId)
    } finally {
      setBusy(false)
    }
  }

  const buildClip = async (id: string): Promise<{ blob: Blob; id: string } | null> => {
    const res = await sendToBackground<ExportResponse & { json?: string }>({
      type: 'EXPORT_BUNDLE',
      id,
    })
    if (!res.ok || !res.json) {
      setError(res.error ?? 'Export failed.')
      return null
    }
    const files: Record<string, Uint8Array> = {
      'agent-context.json': strToU8(res.json),
    }
    // If the capture has a narration transcript, also drop a human-readable
    // transcript.txt alongside (Claude reads it from the JSON either way).
    try {
      const parsed = JSON.parse(res.json) as {
        readme?: { mode?: string; agent_brief?: string }
        transcript?: { segments?: { t_ms: number; text: string }[] }
      }
      // README mirrors the JSON mode/brief so the two never disagree.
      files['README.txt'] = strToU8(
        buildReadme(parsed.readme?.mode, parsed.readme?.agent_brief),
      )
      const segs = parsed.transcript?.segments ?? []
      if (segs.length) {
        const txt = segs
          .map((s) => {
            const t = Math.floor(s.t_ms / 1000)
            return `[${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}] ${s.text}`
          })
          .join('\n')
        files['transcript.txt'] = strToU8(txt)
      }
    } catch {
      /* ignore */
    }
    // Always ship a README, even if the JSON couldn't be parsed above.
    if (!files['README.txt']) files['README.txt'] = strToU8(buildReadme())
    // Load the storyboard fresh from IndexedDB so it's attached whenever it
    // exists — don't rely on the popup's (possibly not-yet-loaded) state.
    const fb = await loadFrames(id)
    if (fb?.storyboard) files['storyboard.png'] = await dataUrlToBytes(fb.storyboard)
    // Per-annotation region images so Claude can SEE each marked area.
    const sess = await loadSession(id)
    for (const a of sess?.annotations ?? []) {
      if (a.image) files[`annotations/mark-${a.index ?? 0}.jpg`] = await dataUrlToBytes(a.image)
    }
    const vid = await loadVideo(id)
    if (vid) files['video.webm'] = new Uint8Array(await vid.blob.arrayBuffer())
    const zipped = zipSync(files, { level: 0 })
    return { blob: new Blob([new Uint8Array(zipped)], { type: 'application/zip' }), id }
  }

  const onExport = async () => {
    if (!selectedId) return
    setBusy(true)
    setError(undefined)
    try {
      const clip = await buildClip(selectedId)
      if (!clip) return
      const dlUrl = URL.createObjectURL(clip.blob)
      const a = document.createElement('a')
      a.href = dlUrl
      a.download = `${clip.id}.clip`
      a.click()
      URL.revokeObjectURL(dlUrl)
      setExported(true)
    } catch (err) {
      setError(`Export failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const onShare = async () => {
    if (!selectedId) return
    setBusy(true)
    setError(undefined)
    setShareUrl(undefined)
    try {
      const clip = await buildClip(selectedId)
      if (!clip) return
      const resp = await fetch(`${SHARE_URL}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          'X-Clip-Id': clip.id,
          ...(SHARE_TOKEN ? { 'X-Clip-Token': SHARE_TOKEN } : {}),
        },
        body: clip.blob,
      })
      const data = (await resp.json()) as { ok: boolean; agent_context?: string; error?: string }
      if (!data.ok || !data.agent_context) return setError(data.error ?? 'Share failed.')
      setShareUrl(data.agent_context)
      await navigator.clipboard.writeText(data.agent_context).catch(() => {})
    } catch {
      setError(`Couldn’t reach the share server at ${SHARE_URL}.`)
    } finally {
      setBusy(false)
    }
  }

  const onDownloadVideo = () => {
    if (!videoUrl || !selectedId) return
    const a = document.createElement('a')
    a.href = videoUrl
    a.download = `${selectedId}.webm`
    a.click()
  }

  const onDownloadStoryboard = () => {
    if (!storyboard || !selectedId) return
    const a = document.createElement('a')
    a.href = storyboard
    a.download = `${selectedId}.storyboard.png`
    a.click()
  }

  const onDelete = async (id: string) => {
    await sendToBackground<AckResponse>({ type: 'DELETE_SESSION', id })
    if (selectedId === id) goHome()
    await loadHistory()
  }

  return (
    <div className="cc">
      <header className="cc-head">
        <div className="cc-mark">
          <Sunburst active={recording} size={20} />
          <span className="cc-word">Claude Clip</span>
        </div>
        <span className="cc-local" title="Everything stays on your device. Nothing is uploaded.">
          🔒 Local
        </span>
      </header>

      {view === 'recording' && (
        <RecordingView
          duration={duration}
          host={hostOf(url)}
          counts={counts}
          needsReload={needsReload}
          busy={busy}
          onStop={onStop}
        />
      )}

      {view === 'home' && (
        <HomeView
          busy={busy}
          mic={mic}
          transcribe={transcribe}
          onStart={onStart}
          onToggleMic={() => requestMic(!mic)}
          onToggleTranscribe={() => {
            setTranscribe((v) => {
              const next = !v
              void chrome.storage.local.set({ transcribeEnabled: next })
              return next
            })
          }}
          history={history}
          onOpen={openReview}
          onDelete={onDelete}
        />
      )}

      {view === 'review' && (
        <ReviewView
          summary={history.find((h) => h.id === selectedId)}
          counts={history.find((h) => h.id === selectedId)?.counts ?? counts}
          videoUrl={videoUrl}
          frames={frames}
          storyboard={storyboard}
          exported={exported}
          shareUrl={shareUrl}
          busy={busy}
          onExport={onExport}
          onShare={onShare}
          onDownloadVideo={onDownloadVideo}
          onDownloadStoryboard={onDownloadStoryboard}
          onNew={goHome}
        />
      )}

      {error && <div className="cc-alert">{error}</div>}

      <footer className="cc-foot">Captured on-device via the DevTools Protocol · nothing leaves your PC</footer>
    </div>
  )
}

// ── Recording ───────────────────────────────────────────────────────────────

function RecordingView({
  duration,
  host,
  counts,
  needsReload,
  busy,
  onStop,
}: {
  duration: number
  host?: string
  counts: CaptureCounts
  needsReload: boolean
  busy: boolean
  onStop: () => void
}) {
  return (
    <>
      <div className="cc-stage">
        <button className="cc-orb" data-on onClick={onStop} disabled={busy} aria-label="Stop recording">
          <Sunburst active size={58} />
        </button>
        <div className="cc-timer" data-on>
          {fmtDuration(duration)}
        </div>
        <div className="cc-sub">{host ? `Capturing ${host}` : 'Capturing this tab'}</div>
        {needsReload ? (
          <div className="cc-hint cc-warn">⚠️ Reload this page (F5) to enable drawing &amp; actions</div>
        ) : (
          <div className="cc-hint">✏️ Draw on the page — the toolbar is at the bottom</div>
        )}
      </div>
      <StatGrid counts={counts} />
      <button className="cc-btn primary wide" onClick={onStop} disabled={busy}>
        Stop recording
      </button>
    </>
  )
}

// ── Home (record + history) ─────────────────────────────────────────────────

function HomeView({
  busy,
  mic,
  transcribe,
  onStart,
  onToggleMic,
  onToggleTranscribe,
  history,
  onOpen,
  onDelete,
}: {
  busy: boolean
  mic: boolean
  transcribe: boolean
  onStart: () => void
  onToggleMic: () => void
  onToggleTranscribe: () => void
  history: SessionSummary[]
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <>
      <div className="cc-stage">
        <button className="cc-orb" onClick={onStart} disabled={busy} aria-label="Start recording">
          <Sunburst active={false} size={58} />
        </button>
        <div className="cc-cta">New recording</div>
        <div className="cc-sub">Record a bug on any tab. Claude reads the capture and diagnoses it.</div>
        <div className="cc-toggles">
          <button className="cc-mic" data-on={mic} onClick={onToggleMic} disabled={busy}>
            <span className="cc-mic-dot" data-on={mic} />
            {mic ? 'Mic on' : 'Mic off'}
          </button>
          {mic && (
            <button
              className="cc-mic"
              data-on={transcribe}
              onClick={onToggleTranscribe}
              disabled={busy}
              title="Transcribe narration to text. Uses Chrome's online speech service."
            >
              <span className="cc-mic-dot" data-on={transcribe} />
              {transcribe ? 'Transcribe on' : 'Transcribe off'}
            </button>
          )}
        </div>
        {mic && transcribe && (
          <div className="cc-note">Transcription uses Chrome’s online speech service (not on-device).</div>
        )}
      </div>

      <div className="cc-history">
        <div className="cc-history-head">
          <span>Recent captures</span>
          {history.length > 0 && <span className="cc-count">{history.length}</span>}
        </div>
        {history.length === 0 ? (
          <div className="cc-empty">No captures yet. Hit record to make your first one.</div>
        ) : (
          <ul className="cc-list">
            {history.map((s) => {
              const issues = s.counts.errors + s.counts.networkFailed
              return (
                <li key={s.id} className="cc-item">
                  <button className="cc-item-main" onClick={() => onOpen(s.id)}>
                    <span className="cc-badge" data-bad={issues > 0}>
                      {issues > 0 ? issues : '✓'}
                    </span>
                    <span className="cc-item-body">
                      <span className="cc-item-host">{hostOf(s.url) ?? s.title ?? 'capture'}</span>
                      <span className="cc-item-sub">
                        {fmtDuration(s.durationMs)} · {fmtWhen(s.startedAt)}
                      </span>
                    </span>
                    <span className="cc-pill" data-bad={issues > 0}>
                      {issues > 0 ? 'Issues' : 'Clean'}
                    </span>
                  </button>
                  <button
                    className="cc-del"
                    onClick={() => onDelete(s.id)}
                    title="Delete"
                    aria-label="Delete"
                  >
                    ✕
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}

// ── Review (a finished capture) ─────────────────────────────────────────────

function ReviewView({
  summary,
  counts,
  videoUrl,
  frames,
  storyboard,
  exported,
  shareUrl,
  busy,
  onExport,
  onShare,
  onDownloadVideo,
  onDownloadStoryboard,
  onNew,
}: {
  summary?: SessionSummary
  counts: CaptureCounts
  videoUrl?: string
  frames: FrameRecord[]
  storyboard?: string
  exported: boolean
  shareUrl?: string
  busy: boolean
  onExport: () => void
  onShare: () => void
  onDownloadVideo: () => void
  onDownloadStoryboard: () => void
  onNew: () => void
}) {
  return (
    <>
      <div className="cc-review-head">
        <button className="cc-back" onClick={onNew}>
          ‹ New recording
        </button>
        <div className="cc-review-title">
          {hostOf(summary?.url) ?? 'Capture'} · {summary ? fmtDuration(summary.durationMs) : ''}
        </div>
      </div>

      <StatGrid counts={counts} />

      {videoUrl && (
        <div className="cc-preview">
          <video className="cc-video" src={videoUrl} controls playsInline />
          <button className="cc-video-dl" onClick={onDownloadVideo}>
            Download video
          </button>
        </div>
      )}

      {frames.length > 0 && (
        <div className="cc-story">
          <div className="cc-story-head">
            <span>Storyboard · {frames.length} keyframes</span>
            {storyboard && (
              <button className="cc-story-dl" onClick={onDownloadStoryboard}>
                Download for Claude
              </button>
            )}
          </div>
          <div className="cc-strip">
            {frames.map((f) => (
              <figure key={f.id} className="cc-frame" data-trigger={f.trigger} title={f.caption}>
                <img src={f.dataUrl} alt={f.caption} />
                <figcaption>
                  <b>{f.label}</b> · {(f.tMs / 1000).toFixed(1)}s<span>{f.caption}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      <div className="cc-actions">
        <button className="cc-btn primary" onClick={onExport} disabled={busy}>
          {exported ? 'Exported ✓' : 'Export .clip'}
        </button>
        {SHARE_ENABLED && (
          <button className="cc-btn ghost" onClick={onShare} disabled={busy}>
            Share link
          </button>
        )}
      </div>
      {shareUrl && <div className="cc-sharelink">Copied · {shareUrl}</div>}
    </>
  )
}

// ── shared ──────────────────────────────────────────────────────────────────

function StatGrid({ counts }: { counts: CaptureCounts }) {
  return (
    <div className="cc-grid">
      <Stat label="Network" value={counts.network} />
      <Stat label="Failed" value={counts.networkFailed} tone="danger" />
      <Stat label="Console" value={counts.console} />
      <Stat label="Errors" value={counts.errors} tone="danger" />
      <Stat label="Actions" value={counts.interactions} />
      <Stat label="Draws" value={counts.annotations} tone="accent" />
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'danger' | 'accent' }) {
  return (
    <div className="cc-stat" data-tone={tone} data-live={value > 0}>
      <div className="cc-stat-value">{value}</div>
      <div className="cc-stat-label">{label}</div>
    </div>
  )
}
