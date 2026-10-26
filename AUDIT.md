# Claude Clip — Ship Readiness Audit

> Full code audit of the extension, servers, and build. Every item below is a
> concrete, verified finding with a file reference. Work through it top-down:
> the batches are ordered by what actually blocks shipping.

**Audited:** 2026-07-21 → 2026-07-22
**Verdict:** The core thesis (CDP-depth capture + an LLM-first artifact) is right
and well executed. What's missing is failure semantics, resource discipline, a
few real privacy holes, and honesty between the docs and the code.

**Legend:** `[x]` done · `[ ]` open · 🔴 blocker · 🟠 high · 🟡 medium · ⚪ polish

---

## ✅ Completed

### Batch 1 — Store readiness & permissions (done 2026-07-22)
- [x] Moved cross-site host access to **runtime, per-domain** —
      `optional_host_permissions: ['<all_urls>']`, requested at Record time from
      the popup gesture (`ensureCapturePermission` in `src/popup/Popup.tsx`).
- [x] Dropped the `tabs` permission; kept `activeTab` (needed to read the current
      tab's URL to know which origin to request).
- [x] Added `minimum_chrome_version: '116'` (MAIN-world 111+, offscreen 109+).
- [x] Added `LICENSE` (MIT) and `PRIVACY.md` (data-handling disclosure).
- [x] `.gitignore` now excludes `*.clip` / `*.webm` / `*.mp4` / storyboards;
      removed the stray Vite timestamp file.
- [x] Background guard checks the per-origin grant + blocks `file:`/`view-source:`.

> ⚠️ **Learned the hard way:** `debugger` **cannot** be an optional permission.
> Chrome rejects it ("Permission 'debugger' cannot be listed as optional") and
> silently omits it, which breaks all capture. It must stay in required
> `permissions`. Its install warning is unavoidable for any CDP-based tool.

### Third-party extension noise (done 2026-07-22)
- [x] Found via a real capture (`clip_mrvp41rd`, on a client staging site): the
      **axe DevTools extension's** telemetry (`axe.deque.com` CORS failure) was
      captured and became the **false `primary_suspect`**, flipping a *feedback*
      clip into *bug* mode and burying the user's actual notes.
- [x] `src/background/cdp.ts` — drop requests whose **initiator** is an extension
      script (`isExtensionInitiated`); drop browser logs whose url is an
      extension origin or that reference a dropped request.
- [x] `src/background/bundle.ts` — `isRecorderNoise` extended to cover
      `kind: 'log'` (extension url) and `kind: 'network'` (extension initiator).

---

## 🔴 Batch 2 — Server lockdown + privacy holes  ← **DO THIS NEXT**

### Server security (`server/`)
- [ ] 🔴 **Bind to loopback.** `share.ts:113` and `demo.ts:269` call
      `server.listen(PORT)` with no host → Node binds `0.0.0.0`, so anyone on the
      LAN can reach it. Contradicts the "local-first" claim. Bind `127.0.0.1`.
- [ ] 🔴 **Unauthenticated upload + wildcard CORS.** `share.ts:21-50` —
      `Access-Control-Allow-Origin: *` plus an unauth `POST /upload`. Any site you
      visit can cross-origin POST attacker-controlled `.clip` files into your
      clips dir (CORS gates *reading*, not sending). Add an origin allowlist/token.
- [ ] 🔴 **Unbounded upload body.** `share.ts:44-50` concatenates chunks with no
      size cap and no `Content-Length` check → trivial OOM. Also missing
      `req.on('error')`, so a client reset can crash the process.
- [ ] 🔴 **Zip bomb on `.clip` parse.** `clips.ts:51-55` `unzipSync` inflates every
      entry with no size/ratio limit. Selective + limited extraction needed.
- [ ] 🟠 **Whole directory decompressed per request.** `clips.ts:70-82` `findClip`
      runs `allClips()` → unzips *every* clip just to find one, on every MCP tool
      call and HTTP request. Index by filename instead.
- [ ] 🟠 **Full capture readable cross-origin.** `share.ts:64-69` serves the entire
      context (DOM snapshots, network bodies) with `*` CORS and no auth.
- [ ] 🟡 Sync `fs` + decompression inside request handlers blocks the event loop.
- [ ] 🟡 `clips.ts:37-63` cache never evicts entries for deleted files.
- [ ] 🟡 `share.ts:100-109` `esc()` doesn't escape quotes but interpolates into
      HTML attributes.
- [ ] ⚪ `demo.ts:227-237` `/api/slow` timer never cleared on client disconnect.
- [ ] ⚪ `demo.ts` port comment says 4900, default is 4100.

### Privacy holes (capture side)
- [ ] 🔴 **`outerHTML` captured unredacted at source.** `src/content/overlay.ts:363`
      serializes up to 1500 chars of the marked element — `value="…"`, `data-*`,
      names/emails/order data — with no masking.
- [ ] 🟠 **Page console args captured verbatim.** `src/content/main-world.ts:108-115`
      forwards `console.error/warn` args (incl. `JSON.stringify`'d objects) with
      no length cap and no scrubbing. Apps log tokens/PII constantly.
- [ ] 🟠 **`<select>` values recorded in the clear.** `src/content/interactions.ts:383-385`
      — text inputs are masked but dropdown selections are not.
- [ ] 🟡 Redaction runs **only at export**, never at rest — raw secrets sit in
      IndexedDB for the session's life. Document or fix.

---

## 🟠 Batch 3 — Media pipeline failure semantics

- [ ] 🔴 **Tab-capture leak on startup failure.** `src/offscreen/offscreen.ts:45-136`
      (catch at `:190`) — if anything after `getUserMedia` throws (AudioContext,
      unsupported MediaRecorder mime, mic prompt), tracks are never stopped:
      recording indicator stuck on, tab audio still routed, AudioContext leaked.
- [ ] 🟠 **Concurrent `OFFSCREEN_START` orphans the first capture.** `offscreen.ts:118`
      — no guard against an existing `active`.
- [ ] 🟠 **The t=0 keyframe is always dropped + costs 2.5s.** `src/offscreen/frames.ts:136-150`
      — a fresh `<video>` is already at `currentTime 0`, so setting it to 0 fires
      no `seeked` and `seek()` hits its 2500ms timeout. Needs a no-op-seek fast path.
- [ ] 🟠 **No `MediaRecorder.onerror`.** `offscreen.ts:103-107` — a mid-session
      error yields a truncated blob that looks like success.
- [ ] 🟠 **Transcriber restart loop.** `src/offscreen/transcribe.ts:60-69` — `onerror`
      is a no-op and `onend` always restarts; fatal errors (`not-allowed`) spin.
- [ ] 🟠 **`dbPromise` poisoned forever.** `src/background/store.ts:25-44` — a
      rejected `openDB` is cached, so all storage fails permanently after one
      failure. No `blocked`/`terminated` handling.
- [ ] 🟠 **No quota handling / no retention.** `store.ts:46-49` — videos accumulate
      in IndexedDB forever; `QuotaExceededError` surfaces only after recording
      ends and the video is simply lost. Needs eviction + a "clear old clips" path.
- [ ] 🟡 Unbounded in-memory chunk buffer (~30 MB/min); nothing is flushed to
      IndexedDB until stop, so eviction mid-record loses everything (`offscreen.ts:104-134`).
- [ ] 🟡 `frames.ts:92-128` — `resolveDuration` seeks to `1e7` then `0`, firing
      stray `seeked` events the extraction loop can mistakenly consume; the
      `play()/pause()` in `frameReady` also nudges `currentTime` off-target.
- [ ] 🟡 `store.ts:83-90` `deleteSession` isn't atomic (3 separate transactions).
- [ ] ⚪ Storyboard stretches tall frames instead of letterboxing (`frames.ts:177,205`).
- [ ] ⚪ Frame data URLs + storyboard both persisted → several MB of duplicate base64.

---

## 🟠 Batch 4 — Content scripts

- [ ] 🔴 **Click timers leak across sessions.** `src/content/interactions.ts:117-136`
      — each click schedules a 1200ms `setTimeout` that `stop()` never clears, so a
      click before stop emits into the **next** recording.
- [ ] 🟠 **Always-on 60fps full redraw.** `src/content/overlay.ts:431-440` — the RAF
      loop clears + re-renders every annotation (RoughJS regenerates each shape)
      the entire recording, even when idle. Constant CPU/battery cost.
- [ ] 🟠 **Shadow-DOM clicks lose their target.** `interactions.ts:97-98` — `e.target`
      retargets to the shadow host; use `e.composedPath()[0]`. Breaks web-component apps.
- [ ] 🟠 **Console wrapper clobbers other libraries.** `main-world.ts:67-125` —
      restores a snapshot taken at load, permanently breaking any wrapper (Sentry
      etc.) installed after us.
- [ ] 🟡 Note editor's `stopPropagation` (bubble phase) can't stop page
      capture-phase shortcuts (`overlay.ts:349-353`).
- [ ] 🟡 Page scripts can spoof bridge messages — no nonce/handshake, no size cap
      (`src/content/main-bridge.ts:30-64`).
- [ ] 🟡 Deferred `describeInMain` re-hits stale coordinates ~1.2s later, after the
      layout may have shifted (`interactions.ts:117-136`).
- [ ] 🟡 Unbounded freehand point arrays re-processed every frame (`overlay.ts:197`).
- [ ] 🟡 `eraser` paints instead of erasing and is unreachable dead code
      (`src/content/draw-engine.ts:85-91`); pen ignores the stroke-width control (`:29-35`).
- [ ] ⚪ `index.tsx:43-44` returns `true` for every message, hanging senders' promises.
- [ ] ⚪ Inner-element scrolls report `window.scrollY` (`interactions.ts:160-172`).
- [ ] ⚪ SPA nav polled every 700ms; same-URL state changes missed (`interactions.ts:177-187`).
- [ ] ⚪ Marks are viewport-anchored, so they detach from content on scroll.

---

## 🟡 Batch 5 — Popup, build, a11y

- [ ] 🟠 **Export download race.** `src/popup/Popup.tsx:329-334` — `revokeObjectURL`
      fires synchronously after `click()` and the anchor is never appended; large
      `.clip` blobs can silently produce a zero-byte download.
- [ ] 🟠 **Unhandled rejections every 500ms** when the service worker is cold —
      `Popup.tsx:131-149` `refresh()` has no try/catch and `setStatus(s.status)`
      throws on an undefined reply, blanking the UI.
- [ ] 🟠 **No React error boundary** — `src/popup/main.tsx:6-10`; one bad row
      white-screens the popup.
- [ ] 🟠 **Message contract lies.** `EXPORT_BUNDLE` is typed `ExportResponse` but the
      whole export depends on a bolted-on `res.json` via `@ts-expect-error`
      (`src/shared/messages.ts:73-77`, `src/background/index.ts:460-475`).
- [ ] 🟡 `sendToBackground<T>` is an unchecked cast with no request→response
      correlation (`messages.ts:103-105`); `MsgResponse` union is incomplete.
- [ ] 🟡 Mic toggle flips on before the grant is confirmed (`Popup.tsx:235-237`).
- [ ] 🟡 `window.close()` on an extension-opened tab is unreliable
      (`src/permission/permission.ts:47,59`) — use `chrome.tabs.remove`.
- [ ] 🟡 `loadPreview` re-runs on every `frameCount` poll tick, resetting the video
      mid-playback (`Popup.tsx:193-195`).
- [ ] 🟡 A11y: toggles lack `aria-pressed`/`role="switch"`; error + share banners
      lack `role="alert"`/`aria-live`.
- [ ] ⚪ Production source maps shipped (`vite.config.ts:21`) — gate to dev.
- [ ] ⚪ `onShare` doesn't check `resp.ok` (`Popup.tsx:351-357`).
- [ ] ⚪ No `:focus-visible` styles; `--text-faint` is borderline below WCAG AA.
- [ ] ⚪ `.clip` zip uses `level: 0`, leaving JSON/bodies uncompressed (`Popup.tsx:318`).

---

## 📢 Batch 6 — Close the docs/reality gap

The README and PLAN promise things the code doesn't do. Either build them or
relabel them as planned — a developer who inspects the output will notice.

- [ ] 🔴 **Source maps are not implemented.** Docs promise "source-mapped stack
      traces"; `src/background/index.ts:482` fetches the *deployed minified* file
      and `bundle.ts:711` shows those lines. On a production site `source_context`
      is one 40,000-char minified line.
- [ ] 🟠 **WebSocket / SSE frames + `*ExtraInfo` raw headers are not captured.**
      `src/background/cdp.ts:119-134` handles only request/response/console/
      exception/log. PLAN §4a sells these as the moat over Sentry/LogRocket.
- [ ] 🟡 `src/background/noise.ts:20,52` — the `facebook.com/tr` pattern can never
      match (a path tested against a hostname); host matching uses `includes`, so
      `evil-segment.com` false-positives.
- [ ] 🟡 `src/background/keyframes.ts:156-161` — `host()` returns `pathname`, so
      network frame captions drop the hostname.
- [ ] ⚪ `derivePrimarySuspect` picks `errors[0]` by time, so an early unrelated
      404 can outrank the real 500.

---

## 🏪 Chrome Web Store submission checklist

- [x] MIT `LICENSE`
- [x] `PRIVACY.md` written
- [ ] Host the privacy policy at a public URL and paste it in the dashboard
- [ ] Fill the **Privacy practices** tab — you can honestly answer *no data
      collected / not sold / not transferred* because capture is local-first
- [ ] Write single-purpose reviewer notes explaining **why `debugger` is required**
      (real response bodies + browser security logs are impossible without CDP)
- [ ] Replace `Copyright (c) 2026 Claude Clip authors` with your legal name
- [ ] Decide the fate of the hardcoded `http://localhost:4747` share URL in
      `Popup.tsx:15` before publishing (gate it behind a dev flag)
- [ ] Consider dynamic `chrome.scripting.registerContentScripts` to drop the
      remaining `<all_urls>` content-script install warning (fights CRXJS's
      content-hashed filenames — non-trivial)
- [ ] Delete the stray `clip_*.clip` and `.mp4` test files from the repo root

---

## Notes

- Typecheck (`npx tsc --noEmit`) and build (`npx vite build`) are both green as of
  2026-07-22. Keep them green — run both after every batch.
- `debugger` cannot be optional. Do not try again.
- The remaining install warning comes from `content_scripts` matching `<all_urls>`,
  not from `host_permissions`.
