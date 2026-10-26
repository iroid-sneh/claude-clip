// ─────────────────────────────────────────────────────────────────────────
// Claude Clip share server (Mode B from PLAN.md §6). A tiny local HTTP server
// so a Clip is reachable from a link:
//
//   POST /upload                       ← extension uploads a .clip (zip) body
//   GET  /api/agent-context.json?id=X  ← WebFetch-able correlated JSON
//   GET  /storyboard/X.png             ← keyframe storyboard image
//   GET  /share/X                      ← human landing page
//   GET  /                             ← team install page (extension zip + steps)
//   GET  /download/claude-clip.zip     ← the packaged extension (npm run package)
//
// Runs locally by default (bound to 127.0.0.1). For a shared team server set
// the CLAUDE_CLIP_* vars in .env.production (see .env.example) and run it
// under pm2 (ecosystem.config.cjs). No framework — Node built-ins only.
// ─────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipsDir, findClip } from './clips.ts'

const PORT = Number(process.env.CLAUDE_CLIP_PORT || 4747)
const HOST = process.env.CLAUDE_CLIP_HOST || '127.0.0.1'
// The address teammates/Claude use to reach this server — goes into share links.
const PUBLIC_URL = (process.env.CLAUDE_CLIP_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')
// When set, uploads must carry a matching X-Clip-Token (the team build bakes it in).
const TOKEN = process.env.CLAUDE_CLIP_TOKEN || ''
const MAX_UPLOAD_BYTES = Number(process.env.CLAUDE_CLIP_MAX_MB || 200) * 1024 * 1024
const DOWNLOAD_ZIP = process.env.CLAUDE_CLIP_DOWNLOAD || join(process.cwd(), 'release', 'claude-clip.zip')

function cors(res: import('node:http').ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Clip-Id, X-Clip-Token')
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  cors(res)
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // ── upload a .clip ──────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/upload') {
    if (TOKEN && req.headers['x-clip-token'] !== TOKEN) {
      return json(res, 401, { ok: false, error: 'Invalid upload token — reinstall the latest extension build.' })
    }
    const id = (req.headers['x-clip-id'] as string) || `clip_${Date.now().toString(36)}`
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (c) => {
      if (aborted) return
      size += (c as Buffer).length
      if (size > MAX_UPLOAD_BYTES) {
        aborted = true
        json(res, 413, { ok: false, error: `Clip is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` })
        req.destroy()
        return
      }
      chunks.push(c as Buffer)
    })
    req.on('error', () => {
      aborted = true
    })
    req.on('end', () => {
      if (aborted) return
      try {
        mkdirSync(clipsDir(), { recursive: true })
        const file = `${id.replace(/[^\w.-]/g, '_')}.clip`
        writeFileSync(join(clipsDir(), file), Buffer.concat(chunks))
        json(res, 200, {
          ok: true,
          id,
          share: `${PUBLIC_URL}/share/${id}`,
          agent_context: `${PUBLIC_URL}/api/agent-context.json?id=${id}`,
        })
      } catch (err) {
        json(res, 500, { ok: false, error: (err as Error).message })
      }
    })
    return
  }

  // ── WebFetch-able agent-context.json ────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/agent-context.json') {
    const clip = findClip(url.searchParams.get('id') || '')
    if (!clip) return json(res, 404, { error: 'clip not found' })
    return json(res, 200, clip.ctx)
  }

  // ── storyboard image ────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname.startsWith('/storyboard/')) {
    const id = url.pathname.slice('/storyboard/'.length).replace(/\.png$/i, '')
    const clip = findClip(id)
    if (!clip?.storyboard) {
      res.writeHead(404)
      return res.end('no storyboard')
    }
    res.writeHead(200, { 'Content-Type': 'image/png' })
    return res.end(Buffer.from(clip.storyboard))
  }

  // ── landing page ────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname.startsWith('/share/')) {
    const id = url.pathname.slice('/share/'.length)
    const clip = findClip(id)
    if (!clip) {
      res.writeHead(404, { 'Content-Type': 'text/html' })
      return res.end(`<h1>Clip "${id}" not found</h1>`)
    }
    const r = clip.ctx.readme ?? {}
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(landing(id, r, !!clip.storyboard))
  }

  // ── packaged extension for the team ─────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/download/claude-clip.zip') {
    if (!existsSync(DOWNLOAD_ZIP)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return res.end('Not packaged yet — run `npm run package` on the server.')
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="claude-clip.zip"',
    })
    return res.end(readFileSync(DOWNLOAD_ZIP))
  }

  // ── install page ────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(installPage())
  }

  res.writeHead(404, { 'Content-Type': 'text/html' })
  res.end('<h1>Claude Clip share server</h1><p>POST /upload · GET /api/agent-context.json?id=…</p>')
})

const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[m]!)

function installPage(): string {
  const ready = existsSync(DOWNLOAD_ZIP)
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install Claude Clip</title>
<body style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#0b0b0f;color:#f5f5f7">
<h1 style="font-size:22px">Install Claude Clip</h1>
<p style="color:#a1a1aa">Record a bug on any site and hand Claude one link. Internal tool — Chrome or Edge 116+.</p>
${ready ? `<p><a href="/download/claude-clip.zip" style="display:inline-block;background:#d97757;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Download claude-clip.zip</a></p>` : `<p style="color:#f87171">The extension hasn't been packaged on this server yet.</p>`}
<ol>
<li>Unzip it somewhere <b>permanent</b>, e.g. <code>Documents\\claude-clip</code> (not Downloads — Chrome loads it from that folder every time).</li>
<li>Open <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>) and turn on <b>Developer mode</b>.</li>
<li>Click <b>Load unpacked</b> and select the unzipped <code>claude-clip</code> folder (the one containing <code>manifest.json</code>).</li>
<li>Pin it from the puzzle-piece menu. Open a site → click the icon → <b>Start recording</b>.</li>
</ol>
<h2 style="font-size:17px;margin-top:28px">Updating</h2>
<p>Download the new zip, replace the files <b>in the same folder</b>, then click the ↻ reload icon on the Claude Clip card in <code>chrome://extensions</code>. Using a different folder resets your recording history.</p>
<h2 style="font-size:17px;margin-top:28px">Sharing a clip</h2>
<p>After recording: <b>Stop</b> → <b>Create share link</b>. The link is copied — paste it to a teammate or to Claude.</p>
</body>`
}

function landing(id: string, r: any, hasStoryboard: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>Claude Clip · ${esc(id)}</title>
<body style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;background:#0b0b0f;color:#f5f5f7">
<h1 style="font-size:20px">Claude Clip · ${esc(id)}</h1>
<p><b>Symptom:</b> ${esc(r.observed_symptom)}</p>
<p><b>Suspect:</b> ${esc(r.primary_suspect)}</p>
${hasStoryboard ? `<img src="/storyboard/${esc(id)}.png" style="max-width:100%;border-radius:10px;border:1px solid #333">` : ''}
<p style="margin-top:24px;color:#a1a1aa">Give Claude this link and ask it to WebFetch the correlated capture:</p>
<code style="display:block;background:#17171c;padding:12px;border-radius:8px;color:#d97757">${esc(PUBLIC_URL)}/api/agent-context.json?id=${esc(id)}</code>
</body>`
}

server.listen(PORT, HOST, () => {
  console.error(
    `[claude-clip] share server on ${HOST}:${PORT} (public: ${PUBLIC_URL}) — clips dir: ${clipsDir()}` +
      (TOKEN ? ' — uploads require token' : ' — WARNING: no CLAUDE_CLIP_TOKEN, uploads are open'),
  )
})
