// ─────────────────────────────────────────────────────────────────────────
// Clip store — reads exported .clip bundles (zips) from a directory and parses
// their agent-context.json + storyboard. Shared by the MCP server and the
// HTTP share server. Node-only (not bundled into the extension).
//
// Point it at wherever the extension saves .clip files:
//   CLAUDE_CLIP_DIR=/path/to/Downloads npm run mcp
// Defaults to ./clips in the project.
// ─────────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'

export interface ClipEntry {
  id: string
  file: string
  mtimeMs: number
  ctx: any // parsed agent-context.json
  storyboard?: Uint8Array // storyboard.png bytes, if present
}

const DIR = process.env.CLAUDE_CLIP_DIR || join(process.cwd(), 'clips')

export function clipsDir(): string {
  return DIR
}

function clipFileNames(): string[] {
  try {
    return readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.clip'))
  } catch {
    return []
  }
}

const cache = new Map<string, ClipEntry>()

export function loadClip(file: string): ClipEntry | null {
  const path = join(DIR, file)
  let st
  try {
    st = statSync(path)
  } catch {
    return null
  }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === st.mtimeMs) return cached

  try {
    const buf = readFileSync(path)
    const files = unzipSync(new Uint8Array(buf))
    const jsonBytes = files['agent-context.json']
    if (!jsonBytes) return null
    const ctx = JSON.parse(strFromU8(jsonBytes))
    const entry: ClipEntry = {
      id: ctx.id || file.replace(/\.clip$/i, ''),
      file,
      mtimeMs: st.mtimeMs,
      ctx,
      storyboard: files['storyboard.png'],
    }
    cache.set(file, entry)
    return entry
  } catch {
    return null
  }
}

export function allClips(): ClipEntry[] {
  return clipFileNames()
    .map(loadClip)
    .filter((c): c is ClipEntry => !!c)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function findClip(id: string): ClipEntry | null {
  const clips = allClips()
  return (
    clips.find((c) => c.id === id || c.file === id || c.file === `${id}.clip`) ?? null
  )
}
