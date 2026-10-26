# Claude Clip

> Record a bug on any website — Claude diagnoses it from one file. Captures the network calls (with response bodies), console output, and uncaught errors via the Chrome DevTools Protocol, correlates them on a causal timeline, and exports an `agent-context.json` Claude can read.

This repo contains **Phases 0–6** of [PLAN.md](PLAN.md): the extension skeleton, the CDP capture engine, tab video + audio recording, the **keyframe storyboard** (so Claude can "see" the bug), **interaction semantics** (rage/dead clicks + repro steps + DOM-on-error), **client-side redaction**, the **single-file `.clip` export**, a local **MCP server + share server** (paste a Clip into Claude Code), the Apple-style popup, and an Excalidraw-style annotation overlay.

## Install (team — no clone, no build)

1. Go to this repo's **Releases** page → download **`claude-clip.zip`** from the latest release.
2. Unzip it somewhere **permanent**, e.g. `Documents\claude-clip` (not Downloads — Chrome loads it from that folder every time).
3. Open `chrome://extensions` (Edge: `edge://extensions`) → turn on **Developer mode** → **Load unpacked** → select the unzipped `claude-clip` folder (the one with `manifest.json`).
4. Pin **Claude Clip** from the puzzle-piece menu.

**Updating:** download the new zip, replace the files **in the same folder**, then click ↻ on the Claude Clip card in `chrome://extensions`. (A different folder = a new extension ID = your recording history is gone.)

**Using it:** open the site → click the icon → **Start recording** → reproduce the bug (draw on the page if it helps) → **Stop** → **Export .clip**. Unzip the `.clip` and drag `agent-context.json` + `storyboard.png` into Claude: *"Diagnose the root cause and fix it."*

**Releasing a new version (maintainers):** bump `version` in `manifest.config.ts` → `npm run package` → attach `release/claude-clip.zip` to a new GitHub Release.

## What works today

- **One-click record/stop** with a live badge and duration.
- **CDP capture** (`chrome.debugger`) of:
  - `Network.*` — requests/responses **with bodies**, status, timing, CORS/failure detail, initiator.
  - `Runtime.consoleAPICalled` — every `console.*` with structured args + stack.
  - `Runtime.exceptionThrown` — uncaught exceptions & unhandled rejections.
  - `Log.entryAdded` — browser-internal CORS/CSP/deprecation logs page JS never sees.
- **Tab video + audio recording** — `tabCapture` → an offscreen document runs `MediaRecorder`; an optional **microphone** track is mixed with tab audio via `AudioContext` (tab audio is routed back to the speakers so playback isn't silenced). The `.webm` blob is stored in IndexedDB with **inline preview + download** in the popup.
- **Keyframe storyboard** — because Claude can't read video, the offscreen document seeks the recorded `.webm` to **event-boundary timestamps** (each error + the "last good" frame just before it, each failed request, each annotation, plus start/end/context frames — deduped and capped at ~14), captures a labeled JPEG per moment, and composes them into a single **storyboard PNG** with captions Claude can read in one image. The popup shows the strip and a **Download for Claude** button.
- **Interaction semantics** — a content-script tracker records the reproduction steps: clicks, inputs (**masked** by default), scrolls, and navigations. It derives **rage clicks** (≥3 clicks on the same target in ~1s) and **dead clicks** (a click that produced no DOM change / navigation — a likely broken handler), and captures a compact **DOM accessibility snapshot at the moment an uncaught error fires**. The page's **framework + version** (React/Vue/Angular/Next/Svelte) are detected in the MAIN world. The bundle turns all this into a human-readable `repro_steps` list.
- **Live counters** in the popup (network / failed / console / errors / actions / annotations).
- **Excalidraw-style overlay** — pen (pressure), arrow, rectangle, ellipse, highlighter, with a hand-drawn feel (roughjs + perfect-freehand); a `cursor` tool passes clicks through so you can reproduce the bug.
- **Client-side redaction** — before anything is exported, sensitive values are masked on-device: auth/cookie/API-key **headers**, sensitive **URL query params**, known **secret shapes** (JWT, AWS/GitHub/Stripe/Google/Slack keys, private keys, Bearer tokens, DB connection strings, `password=`-style assignments), and **PII** (email, SSN, Luhn-validated credit cards). The bundle reports exactly which rule classes fired.
- **Single-file `.clip` export** — one zip containing the redacted `agent-context.json`, the storyboard PNG, `video.webm`, and a README — the whole bug report in one file to hand to Claude.
- **Local MCP + share servers** — a Node **MCP server** resolves a `.clip` into resources + tools so Claude Code pulls the token-light overview first and heavy detail (network bodies, DOM, storyboard image) only on demand; a tiny **share server** exposes a WebFetch-able `agent-context.json` link. Both run locally — nothing leaves your machine. The popup's **Create share link** uploads to the share server.
- **Correlated export** — `agent-context.json` v2: self-describing `readme`, a causal `timeline` (`caused_by` links errors to the failed request that triggered them), error-first ordering, a frames manifest + `video` reference, and network summary + detail-by-id.
- **Crash-safe** — the session is persisted to IndexedDB continuously, so an evicted MV3 service worker can still export what was captured.

## Load it (unpacked, free, local)

```bash
npm install
npm run build
```

Then in Chrome/Edge:

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Pin **Claude Clip**, open any normal website (not a `chrome://` page), click the icon → **Start recording**.
4. Chrome shows a "started debugging this browser" bar — that's the CDP capture running (expected and honest).
5. Reproduce the bug; annotate with the floating toolbar if you like.
6. **Stop** → **Export for Claude** → drag the downloaded `*.agent-context.json` into Claude.

For live development: `npm run dev` (Vite + CRXJS HMR), then load `dist/`.

## Project layout

```
manifest.config.ts        MV3 manifest (CRXJS)
src/
  shared/                 types + typed message contract
  background/
    index.ts              recorder state machine + message router + offscreen mgmt
    cdp.ts                the CDP capture engine (the differentiator)
    bundle.ts             agent-context.json builder (correlated timeline)
    redact.ts             client-side secret/PII/header redaction
    keyframes.ts          event-boundary keyframe selection
    store.ts              IndexedDB persistence (session + video + frames)
  offscreen/
    offscreen.ts          MediaRecorder host (tab video+audio+mic mixing)
    frames.ts             keyframe extraction + storyboard PNG composition
  popup/                  Apple-style popup UI (React)
  server/                 Node-only (not bundled into the extension)
    clips.ts              reads/parses exported .clip zips from a directory
    mcp.ts                MCP server (stdio) — resolves clips for Claude Code
    share.ts              tiny HTTP server — WebFetch-able agent-context.json
  content/
    index.tsx             overlay + interaction-tracker bootstrap
    interactions.ts       clicks/input/scroll/nav + rage/dead detection + DOM snapshot
    overlay.ts            canvas + toolbar controller
    draw-engine.ts        roughjs + perfect-freehand rendering
    toolbar.ts            shadow-DOM floating toolbar
```

## Known limitations (by design, this phase)

- **CDP info bar** is unavoidable and you can't attach while DevTools is open on the same tab.
- `Network.getResponseBody` is unreliable for large/streamed bodies — a content-script `fetch`/`XHR` fallback lands in a later phase.
- **Keyframes are extracted after you stop** (the offscreen doc seeks the video), so the storyboard appears in the popup a moment later. WebM from `MediaRecorder` can report an unknown duration; the extractor forces it to resolve before seeking.
- **`.clip` is a zip** — Claude can't open a zip directly, so unzip it and drag `agent-context.json` + `storyboard.png` into Claude (the storyboard's own "Download for Claude" button gives you the PNG straight away).
- **Redaction is heuristic** — it catches common secret/PII shapes but is not a guarantee; review before sharing externally.
- **Dead-click detection** is judged from DOM mutations + navigation only (the content script can't see network from the page), so a click that only fires a background request without a visual change may be flagged dead. Navigation and framework globals are read via polling / the MAIN world respectively, so both are best-effort.
- **Mic** needs a one-time permission grant (the popup requests it when you toggle Mic on).

## Using a .clip with Claude

1. Record a bug, stop, click **Export .clip**.
2. Unzip it (or use the storyboard's **Download for Claude** for the PNG directly).
3. Drag `agent-context.json` + `storyboard.png` into Claude: *"Diagnose the root cause. The timeline is causal; frames are labeled Image N."*

## Test pages (verify capture)

A demo server with a hub + 4 JS-driven pages that deliberately trigger different failure classes, so you can record them and confirm the capture:

```bash
npm run demo   # http://localhost:4900  (open it via localhost, not 127.0.0.1)
```

| Page | What it triggers | Verifies |
|---|---|---|
| `/good` | successful fetch, clean `console.info/log` | baseline (no errors, 200s) |
| `/broken-api` | `POST /api/fail` → 500, `/api/notfound` → 404, `console.error`, unhandled promise rejection | failed network + response bodies + console errors + exceptions |
| `/js-errors` | uncaught `TypeError` on load, a **dead click**, a crash-on-click, `console.warn` | exceptions with stacks + dead-click detection |
| `/network-chaos` | DNS failure, **CORS block**, slow (3s) request, JSON parse error | `loadingFailed`, CORS logs, timing, parse errors |

**How to test:** `npm run demo` → reload the extension → open `http://localhost:4900/broken-api` → **reload the page** → Start recording → click the buttons (and draw on the page) → Stop → Export `.clip`. The `agent-context.json` should show the 500 with its body, the console errors, the exception, and (on `/js-errors`) a `[DEAD]` click. Repeat with `/good` to confirm a clean capture has no errors.

## Claude Code integration (MCP + share servers)

Both servers read exported `.clip` files from a directory (`CLAUDE_CLIP_DIR`, default `./clips`). Point it at wherever the extension saves downloads, e.g. your Downloads folder.

**MCP server** — lets Claude Code diagnose a clip directly:

```bash
# register once (stdio server)
claude mcp add claude-clip -e CLAUDE_CLIP_DIR="$HOME/Downloads" -- node --experimental-strip-types server/mcp.ts
```

Then in Claude Code: *"list clips, then diagnose the latest one."* It calls `list_clips` → `get_clip_overview` (token-light: readme, repro steps, causal timeline, errors, network summary) and pulls `get_network_detail` / `get_dom_snapshots` / `get_storyboard` only when needed.

Tools exposed: `list_clips`, `get_clip_overview`, `get_network_detail`, `get_dom_snapshots`, `get_storyboard` (returns the storyboard as an image). Each clip is also a `clip://<id>` resource (overview, prioritized for the assistant).

**Share server** — a WebFetch-able link (also what the popup's *Create share link* uploads to):

```bash
CLAUDE_CLIP_DIR="$HOME/Downloads" npm run share   # http://localhost:4747
```

- `POST /upload` — the popup uploads a `.clip` here.
- `GET /api/agent-context.json?id=<id>` — hand this URL to Claude (WebFetch).
- `GET /share/<id>` — human landing page. `GET /storyboard/<id>.png` — the image.

> Requires Node ≥ 22.6 (uses `--experimental-strip-types` to run the TypeScript servers directly). Override the port with `CLAUDE_CLIP_PORT`.

## Next up (from PLAN.md)

Phase 7 — Core Web Vitals + perf (LCP/CLS/INP with attribution) → onboarding/permissions polish → Chrome Web Store packaging.
