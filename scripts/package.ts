// ─────────────────────────────────────────────────────────────────────────
// Packages the built extension (dist/) into release/claude-clip.zip for the
// team to "Load unpacked". Everything sits under a top-level claude-clip/
// folder so unzipping yields one folder to select. Run via `npm run package`
// (which builds first, baking in VITE_SHARE_URL / VITE_SHARE_TOKEN).
// ─────────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { zipSync } from 'fflate'

const DIST = join(process.cwd(), 'dist')
const OUT_DIR = join(process.cwd(), 'release')
const OUT = join(OUT_DIR, 'claude-clip.zip')

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('[package] dist/manifest.json missing — run `npm run build` first.')
  process.exit(1)
}

const files: Record<string, Uint8Array> = {}
function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (!name.endsWith('.map')) files[`claude-clip/${relative(DIST, path).split('\\').join('/')}`] = readFileSync(path)
  }
}
walk(DIST)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, zipSync(files, { level: 9 }))
const version = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')).version
console.error(`[package] ${OUT} — v${version}, ${Object.keys(files).length} files, ${(statSync(OUT).size / 1024).toFixed(0)} KB`)
