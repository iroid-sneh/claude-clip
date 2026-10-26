# Claude Clip — Project Plan

> **Hit record. Reproduce the bug. Stop.** Paste one link into Claude — and Claude sees exactly what the user saw, reads every failed API call and console error, follows the causal chain from click → request → exception → broken pixel, and tells you what's wrong and how to fix it.

Claude Clip is a Chrome/Edge (Manifest V3) extension that turns any bug on any website into a single, self-describing artifact an AI can diagnose from a link. It captures more than Jam, Sentry, or LogRocket — real response bodies, WebSocket frames, browser-internal CORS/CSP logs — because it records through the **Chrome DevTools Protocol**, not a page-level SDK. Then it does the one thing none of them do: it formats the capture *specifically for how Claude reads*.

---

## 1. The One-Sentence Goal

**"Any user, on any site, hits record, reproduces the bug, stops — and Claude reads one link and diagnoses the root cause: the video symptom, the failed request, the console error, and the exact line of code, all correlated on one timeline."**

The differentiator isn't "record a screen." Dozens of tools do that. The differentiator is a capture bundle **engineered for an LLM's attention budget** — error-first, causally linked, keyframe-based (because Claude can't watch video), and pre-digested so Claude reasons over signal, not noise.

---

## 2. Why This Wins — The Two Insights That Shape Everything

### Insight 1 — Capture through CDP, not an SDK, and you beat every competitor on *depth*.
SDK-based tools (LogRocket, Sentry Session Replay, OpenReplay) can only see what page JavaScript can see. They **cannot** get raw response bodies for cross-origin/opaque responses, real WebSocket/SSE frames, or browser-internal CORS/CSP/security logs. Claude Clip attaches `chrome.debugger` (Chrome DevTools Protocol) and captures **all of it — on any site, with zero SDK installed in the target app.** That matches Jam's "works everywhere" while adding DevTools-grade depth.

> Source: [chrome.debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) · [CDP Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)

### Insight 2 — Claude cannot read video. So the artifact is a *storyboard + timeline*, not a movie.
The Claude API accepts **images (JPEG/PNG/GIF/WebP) and PDFs only — there is no video content type**, and for animated GIFs "only the first frame is used." This is the single most important design constraint in the project, and every competitor that ships "a video link to an AI" is quietly relying on the AI *not* actually watching it.

Claude Clip instead reduces the recording **client-side** to a handful of **labeled, timestamped keyframes** sampled at event boundaries (error, failed request, click, navigation, DOM change), and pairs them with a **correlated text timeline** the frames reference by ID. ~6–15 well-chosen frames beat 100 uniform ones — for the 100-image cap, the request-size ceiling, and Claude's attention budget.

> Source: [Anthropic Vision docs](https://platform.claude.com/docs/en/build-with-claude/vision) · [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**Everything below is downstream of these two insights.**

---

## 3. Product Story — Three Screens

```
   ┌── RECORD ──────────┐     ┌── REPRODUCE ───────┐     ┌── DIAGNOSE ────────┐
   │  ● one click        │     │  draw • narrate     │     │  paste link → Claude│
   │  badge turns red    │ ──▶ │  everything captured │ ──▶ │  "The root cause is │
   │  "capturing" banner │     │  silently underneath │     │   POST /pay → 500,  │
   │                     │     │                      │     │   cart.js:88 null…" │
   └─────────────────────┘     └──────────────────────┘     └─────────────────────┘
        3 seconds                  the actual bug              instant root cause
```

The magic moment: the user never assembles a bug report. They just *do the thing that breaks*, and Claude Clip has already captured the video symptom, the network failure, the console error, the DOM state, and the reproduction steps — correlated and redacted — into one link.

---

## 4. Capture Surface — What We Record (and How)

Claude Clip uses a **hybrid capture engine**: CDP for depth, an injected content-script layer for the things CDP can't see well (visual replay, Core Web Vitals with attribution, interaction *semantics*). This dual approach is deliberate — each covers the other's blind spots.

### 4a. CDP layer (`chrome.debugger`) — the depth advantage

| Signal | CDP source | Why it matters to Claude |
|---|---|---|
| **Network lifecycle** | `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `loadingFailed` | Method, URL, status, MIME, timing waterfall (DNS/connect/SSL/**TTFB**/download), remote IP, cache flags. Most web bugs are a bad request/response. |
| **Response & request bodies** | `Network.getResponseBody` / `getRequestPostData` + `Fetch.requestPaused` interception | Turns "500" into the actual error payload. Interception at pause-time is more reliable than post-hoc fetch. |
| **Raw headers + blocked cookies** | `Network.requestWillBeSentExtraInfo` / `responseReceivedExtraInfo` | Auth, caching, **SameSite/`Set-Cookie` rejections**, header casing — invisible in the normal events. |
| **CORS / failure detail** | `Network.loadingFailed.corsErrorStatus` + `blockedReason` | Dedicated CORS + blocked-request reasons. |
| **Redirect + initiator chains** | `requestWillBeSent.redirectResponse` / `.initiator` | Auth loops, wrong-endpoint, "which script fired this." |
| **WebSocket frames** | `Network.webSocketFrameSent` / `webSocketFrameReceived` / `webSocketClosed` | Full payloads + handshake — essential for realtime-app bugs. |
| **Server-Sent Events** | `Network.eventSourceMessageReceived` | event/id/data per SSE message. |
| **Console (structured)** | `Runtime.consoleAPICalled` | Every `console.*` with **typed argument previews** (objects stay inspectable, not `[object Object]`) + stack traces. |
| **Uncaught exceptions + rejections** | `Runtime.exceptionThrown` | Full `ExceptionDetails` + async stack. *The bug is often literally named here.* |
| **Browser-internal logs** | `Log.entryAdded` (source: security/network/**cors**/deprecation/violation/intervention) | CSP violations, mixed-content, deprecations — signals page JS never sees. |
| **Runtime perf counters** | `Performance.getMetrics` | `JSHeapUsedSize`, `Nodes`, `JSEventListeners`, `LayoutCount`, `RecalcStyleCount` — leaks, DOM bloat, layout thrash. |
| **Structured DOM snapshot** | `DOMSnapshot.captureSnapshot` | Flattened DOM + whitelisted computed styles + geometry + paint order, in one call — far more AI-parseable than a screenshot. |
| **Exact clicked element** | `DOM.getNodeForLocation` | Resolve the node under a click coordinate → selector + `outerHTML` + box. |
| **Page archive / screenshots** | `Page.captureSnapshot` (MHTML) / `Page.captureScreenshot` | Self-contained rendered document incl. iframes & shadow DOM; keyframe source. |
| **App internals** | `Runtime.evaluate` | Framework + version detection (React/Vue/Angular/Next), Redux/Vuex store state, feature flags. |

### 4b. Content-script layer — the things CDP misses

| Signal | Technique | Why |
|---|---|---|
| **DOM replay** | **rrweb** (`MutationObserver` incremental snapshots) | Reconstruct the session as replayable DOM (what Sentry Replay is built on) — lighter than video, and a keyframe source. |
| **Core Web Vitals + attribution** | Google **`web-vitals`** lib / `PerformanceObserver` (`buffered:true`) | LCP, CLS, INP, FCP, TTFB, long tasks — **with the element/interaction/request that caused the poor metric.** For "it's slow/janky" bugs. |
| **Response-body fallback** | `fetch`/`XHR` wrapper in page context | `Network.getResponseBody` is unreliable for large/streamed responses ([issue #44](https://github.com/ChromeDevTools/devtools-protocol/issues/44)) — wrap fetch/XHR as a backstop. |
| **Interaction timeline** | Capture-phase listeners (clicks, scroll, input, nav) | The reproduction steps Claude restates. Input **masked by default**. |
| **Rage clicks / dead clicks** | Derived: ≥3 clicks same target ~1–2s / click with no DOM-mutation·nav·request response | Cheap, extremely high-signal — localizes the broken control and the user's frustration moment. |
| **Environment header** | `navigator.userAgent(Data)`, viewport, DPR, `navigator.connection.effectiveType`, `deviceMemory`, timezone, locale, color-scheme | Reproduction context, attached to every bundle. |

### 4c. The key technical decision — CDP vs. injected interceptor
- **`chrome.debugger`/CDP** — full request *and* response bodies, all console output, exceptions, WS/SSE frames, browser security logs. **Downside:** Chrome shows a "started debugging this browser" info bar, and can't attach while DevTools is open on the same tab.
- **Injected `fetch`/`XHR` wrapper only** — no banner, but misses service-worker traffic, `sendBeacon`, cross-origin bodies, WebSockets, and all browser-internal logs; easier for pages to interfere with.

**Decision for v1: CDP as primary, content-script as complement.** Completeness > cosmetic banner — and for a debugging tool, the banner is *honest*: it tells the user capture is active.

---

## 5. Capture Tiers — Spend Bytes Where They Pay Off

Not every signal is worth capturing all the time. We tier by **diagnostic leverage per byte for an LLM** (ranking synthesized from CDP capability + how real AI debuggers like Sentry Seer and Chrome DevTools AI curate context).

**🟢 ALWAYS (cheap, high-signal, LLM-friendly as text)**
1. Uncaught exceptions + rejections, **source-mapped** stack traces
2. Console errors/warnings with structured args + stacks
3. Failed / non-2xx / CORS network requests (URL, status, error text, blocked reason)
4. Response + request bodies for the failing/relevant requests
5. The exact interacted element + rage/dead-click flags
6. Browser-internal `Log` entries (CORS, CSP, mixed-content, deprecation)
7. Raw request/response headers + blocked cookies
8. Interaction timeline / breadcrumbs (redacted)
9. Environment metadata header

**🟡 ON ERROR / TRIGGER (captured when something breaks)**
10. Structured DOM + computed-style snapshot at the failure moment
11. Framework + versions + Redux/Vuex store state
12. Redirect + initiator chains for the failing request
13. WebSocket / SSE frames (always-on for realtime apps)

**🔵 ON-DEMAND (heavy; perf investigations only)**
14. Core Web Vitals with attribution
15. Runtime perf counters + memory (heap, nodes, listeners)
16. Keyframe storyboard / MHTML archive / rrweb replay
17. Full `Tracing` artifact (long tasks, frame rendering, JS sampling)

> Design rule: **structured text for facts, images for the visual gestalt.** Never rely on a screenshot to convey dense DOM text or exact positions — Claude's vision is approximate on small text, coordinates, and counts. Put facts in the timeline/snapshot; use frames only for "what the user saw."

---

## 6. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser Extension (Manifest V3)                                          │
│                                                                            │
│  ┌───────────────┐   ┌───────────────────────┐   ┌────────────────────┐   │
│  │ Popup UI      │   │ Service Worker (bg)    │   │ Content Script     │   │
│  │ (React)       │   │ ── CDP layer ──        │   │ ── page layer ──   │   │
│  │ • Start/Stop  │──▶│ • chrome.debugger attach│  │ • rrweb replay     │   │
│  │ • Toggles     │   │ • Network/Runtime/Log   │  │ • web-vitals       │   │
│  │ • Live preview│   │ • DOMSnapshot on error  │  │ • fetch/XHR fallbk │   │
│  │ • Redact prefs│   │ • MediaRecorder         │  │ • interaction log  │   │
│  │ • Export/Share│   │ • keyframe extractor    │  │ • rage/dead click  │   │
│  └───────────────┘   │ • bundle builder        │  │ • draw overlay     │   │
│                      └───────────┬─────────────┘  └────────────────────┘   │
│                                  ▼                                          │
│                      ┌───────────────────────┐                             │
│                      │ IndexedDB (local)     │  ← persist continuously;    │
│                      │ • video.webm          │    survives SW eviction     │
│                      │ • frames/*.jpg        │                             │
│                      │ • events (raw)        │                             │
│                      └───────────┬───────────┘                             │
└──────────────────────────────────┼─────────────────────────────────────────┘
                                    ▼
                    ┌─────────────────────────────────┐
                    │ REDACTION PASS (client-side)    │  ← before anything leaves
                    │ headers • bodies • inputs •     │    the device
                    │ secrets (gitleaks) • PII        │
                    │ (Presidio) • frame OCR mask     │
                    └───────────────┬─────────────────┘
                                    ▼
         ┌──────────────────────┐        ┌──────────────────────────────┐
         │ Mode A — .clip file  │   or   │ Mode B — share link          │
         │ (local, offline)     │        │ + /agent-context.json        │
         └──────────┬───────────┘        │ + MCP server (v2)            │
                    │                    └──────────────┬───────────────┘
                    └──────────────┬────────────────────┘
                                   ▼
              ┌────────────────────────────────────────────┐
              │ Claude reads it:                           │
              │  labeled keyframes (image blocks)          │
              │  + agent-context.json                      │
              │  → correlated causal diagnosis             │
              └────────────────────────────────────────────┘
```

---

## 7. The Artifact — `agent-context.json` schema (v2, LLM-first)

This is the single most important deliverable: the thing Claude reads. It is **self-describing** (llms.txt / AGENTS.md pattern), **error-first** (validated by Sentry Seer, which traces *backward* from the failing line), and **causally linked** (every event carries a `caused_by` pointer and shared IDs, following W3C Trace Context).

Ordering is deliberate: **summary → repro steps → correlated timeline → error-first detail → network → DOM a11y snapshot → frames.** High-signal early (attention budget), heavy detail pointed-to by ID (just-in-time).

```jsonc
{
  // ── 1. START HERE — written for the model ────────────────────────────
  "readme": {
    "what_this_is": "Claude Clip bug capture. Read fields in order; frames are attached as labeled images.",
    "app": { "name": "Acme Checkout", "url": "https://app.acme.com/checkout", "commit": "a1b2c3d" },
    "environment": { "browser": "Chrome 141", "os": "Windows 11", "viewport": "1440x900",
                     "dpr": 2, "connection": "4g", "locale": "en-US", "timezone": "Asia/Kolkata" },
    "user_goal": "Complete checkout with a saved card",
    "observed_symptom": "Clicked 'Pay' — spinner never resolved; no confirmation shown",
    "primary_suspect": "POST /api/pay returned 500; console TypeError in cart.js:88",
    "read_order": ["repro_steps", "timeline", "errors", "network_summary", "dom_snapshot", "frames"]
  },

  // ── 2. Clean, extractable repro steps (measurably boosts auto-diagnosis) ─
  "repro_steps": [
    "Load /checkout with 2 items in cart",
    "Select saved Visa ending 4242",
    "Click 'Pay $59.98'",
    "Observe indefinite spinner"
  ],

  // ── 3. THE CORE — one correlated, causal timeline ───────────────────
  "session": { "id": "clip_9f3", "started_at": "2026-07-10T14:03:11.000Z", "duration_ms": 18400 },
  "timeline": [
    { "t_ms": 12040, "step_id": "s5", "type": "user_action", "action": "click",
      "target": "button#pay", "text": "Pay $59.98", "frame": "frame_03", "rage_click": false },
    { "t_ms": 12080, "step_id": "s5", "type": "network", "ref": "net_17",
      "method": "POST", "url": "/api/pay", "status": 500, "duration_ms": 240,
      "caused_by": "s5", "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736" },
    { "t_ms": 12330, "step_id": "s5", "type": "console", "ref": "err_02",
      "level": "error", "summary": "TypeError: cannot read 'id' of undefined (cart.js:88)",
      "caused_by": "net_17" },
    { "t_ms": 12500, "step_id": "s5", "type": "dom_mutation",
      "summary": "spinner shown; no confirmation node", "frame": "frame_04" }
  ],

  // ── 4. ERROR-FIRST detail (OpenTelemetry exception shape) ───────────
  "errors": [
    { "id": "err_02", "exception_type": "TypeError",
      "exception_message": "cannot read properties of undefined (reading 'id')",
      "exception_stacktrace": "at handlePay (cart.js:88)\n at HTMLButtonElement.onclick",
      "source_mapped": true, "first_seen_t_ms": 12330, "count": 1, "related_network": "net_17" }
  ],

  // ── 5. Network: summary table for ALL; full detail only for error-relevant ─
  "network_summary": [
    { "id": "net_17", "method": "POST", "url": "/api/pay", "status": 500,
      "duration_ms": 240, "size_bytes": 512, "detail": "net_detail_17" },
    { "id": "net_16", "method": "GET", "url": "/api/cart", "status": 200, "duration_ms": 60 }
    // …deduped/truncated: "12 successful asset requests omitted"
  ],
  "network_detail": {
    "net_detail_17": {
      "request":  { "headers": { "content-type": "application/json", "authorization": "[REDACTED]" },
                    "body": { "cartId": "c_88", "card": "[REDACTED]" } },
      "response": { "status": 500, "headers": { "…": "…" },
                    "body": { "error": "NullPointerException", "trace_id": "4bf9…" } },
      "timing":   { "ttfb_ms": 210, "total_ms": 240 }, "initiator": "cart.js:81" }
  },

  // ── 6. DOM as compact accessibility snapshot (NOT raw HTML, NOT a screenshot) ─
  "dom_snapshot": {
    "at_t_ms": 12500, "format": "accessibility_tree",
    "tree": "button 'Pay $59.98' [ref=e5] [disabled]\n status 'Processing…' [ref=e6]\n …",
    "note": "a11y snapshot ≈ 10–15× fewer tokens than a screenshot of the same view, and deterministic"
  },

  // ── 7. What changed (cheap, localizing; best-effort, not a standard) ─
  "state_diff": { "route": { "before": "/checkout", "after": "/checkout" },
                  "dom": ["+ div.spinner", "- div.confirmation"] },

  // ── 8. Frame manifest — images attached separately, labeled, timestamped ─
  "frames": [
    { "id": "frame_03", "label": "Image 3", "t_ms": 12040, "caption": "Just before 'Pay' click (last good state)" },
    { "id": "frame_04", "label": "Image 4", "t_ms": 12500, "caption": "After click: spinner, no confirmation (symptom)" }
  ],

  // ── 9. Redaction provenance (trust signal for the reader) ───────────
  "redaction": { "applied": ["auth_headers", "card_luhn", "email_pii", "input_text"],
                 "engine": "presidio + gitleaks-rules", "frames_ocr_masked": true },

  "annotations": [ { "t_ms": 12040, "type": "arrow", "note": "clicked here, nothing happened" } ],
  "version": 2, "id": "clip_ab12cd34", "createdAt": "2026-07-10T14:03:29.397Z"
}
```

**How Claude receives it at diagnosis time:**
1. **2–15 labeled keyframes as `image` blocks, image-then-text** (Anthropic: "Claude works best when images come before text").
2. Then the `agent-context.json` (or a link Claude `WebFetch`es).
3. Then the instruction: *"Diagnose the root cause. The timeline is causal (`caused_by`); frames are labeled `Image N` and stamped `t_ms`. Start from `errors`, correlate to `network_detail`, confirm the symptom against the frames."*

> Design principle: every array item is timestamped (`t_ms`) relative to record start and carries a `caused_by`/`ref` pointer. That correlation — *"at 12.0s the user clicked, POST /pay returned 500, a TypeError fired at cart.js:88, and the spinner hung"* — is what turns raw capture into a **diagnosis**.

---

## 8. How Claude Reads the Link — Delivery Modes

**Mode A — Fully local (private, offline, v1 default)**
- Export a single `.clip` bundle (zip: keyframes + `agent-context.json` + optional `video.webm`) to disk.
- User drags it into Claude / Claude Code. No server, no account, nothing leaves the device unless the user chooses.

**Mode B — Share link (opt-in, fast follow)**
- Upload the redacted bundle to a minimal backend → `https://…/share/<id>`.
- Expose `https://…/api/agent-context.json?id=<id>` so Claude can `WebFetch` from just a link; serve keyframes via signed/expiring URLs.
- Requires: object storage (R2/S3), a thin API, a redaction gate before upload.

**Mode C — MCP server (v2, the endgame)**
- An MCP server resolves a Clip URL into **annotated resources** (`priority` 0.0–1.0, `audience`), so Claude Code pulls just the timeline first and fetches heavy detail (bodies, frames, DOM) *on demand*. This mirrors how **Jam.dev's MCP** lets you paste a link into Claude Code / Cursor and auto-load the context — but with CDP-grade depth underneath.

> v1 ships Mode A. Mode B is a fast follow once the capture engine is proven. Mode C is the strategic moat.

---

## 9. Privacy & Redaction (non-negotiable — this tool records everything)

Redaction happens **client-side, before anything leaves the device.** Model the defaults on session-replay industry standards.

- **Mask by default.** Mask all text inputs and password fields (Sentry/PostHog default). Opt-out selectors (`data-clip-unmask`) reveal only what's needed; `data-clip-block` drops regions entirely.
- **Network scrub.** Strip/placeholder `Authorization`, `Cookie`/`Set-Cookie`, `X-API-Key`, `X-Auth-Token`; keep field names, replace values with `[REDACTED]`.
- **Secret detection.** gitleaks-style regex rules (AWS/GitHub/Stripe keys, private keys, DB URLs) + entropy scoring.
- **PII detection.** Presidio-style recognizers (PERSON, EMAIL, PHONE, CREDIT_CARD with Luhn, SSN) → mask/hash/replace.
- **Frame redaction.** OCR + NER to blur on-screen PII (autofilled emails, account IDs) across all keyframes before storage.
- **Visible capture state.** Badge + the honest CDP info bar — the user always knows recording is on.
- **Per-domain opt-in** (later): only attach the debugger on domains the user enables.
- **Data-retention awareness.** On the Claude API, content isn't retained by default and never trains models without permission; if Zero Data Retention is required, note it disables CORS and excludes the Files API, so frame upload must proxy through a backend.

---

## 10. Competitive Landscape — What We Match and Beat

| Tool | Capture approach | Headline features | Where Claude Clip wins |
|---|---|---|---|
| **Jam.dev** | Extension | Video + console + network + repro steps; rolling last-2-min; **MCP → paste link into Claude Code** | CDP-grade depth (real bodies, WS frames, browser logs); LLM-first bundle format |
| **Sentry Session Replay** | SDK (rrweb) | rrweb DOM replay + breadcrumbs + rage/dead clicks + errors | No SDK needed; works on any site; response bodies + CORS/CSP logs |
| **LogRocket** | SDK (MutationObserver) | Pixel replay + network bodies + Redux time-travel | No SDK install; cross-origin bodies; formatted for Claude |
| **OpenReplay** | SDK (self-host) | Replay + DevTools + state tracking + GraphQL | Any site, zero instrumentation; keyframe+timeline artifact |
| **Bird Eats Bug** | Extension | Screen record + console + network + steps | Deeper capture (WS/SSE, security logs) + AI-native output |
| **Replay.io** | Custom browser runtime | Deterministic time-travel down to syscalls | No special runtime — a plain extension on Chrome/Edge |

**The one-line position:** *Jam's "works on any site" + DevTools' depth + a bundle engineered for how Claude actually reads.*

---

## 11. Tech Stack

- **Extension:** Manifest V3, TypeScript, React (popup + overlay), Vite + CRXJS.
- **Capture (depth):** Chrome DevTools Protocol via `chrome.debugger` — Network / Runtime / Log / DOMSnapshot / Performance / Page.
- **Capture (page layer):** rrweb (DOM replay), Google `web-vitals` (CWV + attribution), `fetch`/`XHR` wrapper (body fallback), capture-phase interaction listeners.
- **Media:** `getDisplayMedia`/`tabCapture` + `MediaRecorder`; Web Audio API for mic/tab-audio mix; client-side keyframe extraction (canvas) at event boundaries.
- **Symbolication:** source-map consumer to resolve minified stacks → original file:line (Sentry/PostHog pattern).
- **Redaction:** gitleaks-style secret rules + Presidio-style PII recognizers + OCR frame masking, all in-browser.
- **Storage:** IndexedDB (`idb`), continuously persisted to survive SW eviction.
- **Backend (Mode B/C, optional):** thin Node/Hono API + object storage (Cloudflare R2/S3); MCP server exposing annotated resources.

---

## 12. Build Phases (milestones)

- **Phase 0 — Skeleton (½ day):** MV3 manifest, popup, service worker, content script, Vite + CRXJS. Loads unpacked, badge toggles.
- **Phase 1 — CDP capture spike (1 day) ⭐ DE-RISKS EVERYTHING:** attach `chrome.debugger`, subscribe to `Network.*`, `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`; buffer with timestamps; dump live to JSON. If this yields clean network + console + error data, the whole project is standard extension work.
- **Phase 2 — Video + audio (1 day):** `getDisplayMedia`/`tabCapture` + mic, `MediaRecorder`, store blob in IndexedDB, preview + download.
- **Phase 3 — Keyframe storyboard (1 day) ⭐ THE UNLOCK:** extract labeled, timestamped frames at event boundaries (error / failed request / click / nav / DOM change) + before/after pair around each error. This is what makes the capture Claude-readable.
- **Phase 4 — Correlated bundle + redaction (1.5 days):** assemble `agent-context.json` v2 (readme → repro → causal timeline → errors → network → DOM a11y snapshot → frames); source-map stacks; run client-side redaction; export `.clip` (Mode A). **Verify Claude diagnoses a real bug from it.**
- **Phase 5 — Interaction semantics (1 day):** rage/dead-click detection, interaction timeline, DOMSnapshot-on-error, framework/state detection.
- **Phase 6 — Drawing overlay (1 day):** injected canvas toolbar (pen/arrow/highlight), annotations recorded with timestamps.
- **Phase 7 — Core Web Vitals + perf (1 day):** `web-vitals` with attribution + `Performance.getMetrics`, for "it's slow/janky" bugs.
- **Phase 8 (optional) — Share backend (2–3 days):** upload API, `agent-context.json` endpoint, expiring links (Mode B).
- **Phase 9 (strategic) — MCP server:** resolve Clip URL → annotated resources for Claude Code (Mode C).
- **Phase 10 — Polish:** onboarding, permissions UX, error states, Chrome Web Store packaging + privacy disclosure.

**MVP = Phases 0–4** (record + audio + CDP network/console/error + keyframe storyboard + correlated redacted bundle Claude can diagnose from).

---

## 13. Known Risks & Open Questions

1. **`Network.getResponseBody` is unreliable** for large/streamed/downloaded responses (can return null / "No data found"). → Fetch-interception + content-script `fetch`/`XHR` wrapper as fallback.
2. **CDP info bar + single-client limit** — unavoidable banner; can't attach while DevTools is open on the tab. Accept for v1 (honest for a debug tool); detect-and-message the DevTools conflict.
3. **Service-worker lifetime (MV3)** — background can be killed mid-recording; persist events to IndexedDB continuously and re-attach on wake.
4. **Video/frame/JSON size** — respect Claude's limits: 100 images/request, 10 MB/image, **32 MB request ceiling**; budget 6–15 keyframes; upload frames via Files API when payloads grow; offer a "network-log-only lite" mode.
5. **Claude can't read video** — already designed around (keyframe storyboard). Don't regress into shipping a raw video link and hoping.
6. **Token cost / context rot** — pre-digest: dedup console with counts, truncate-with-markers, error-first ordering, a11y snapshot over raw HTML, summary-table + detail-by-ID for network.
7. **WebSocket / streaming / beacon coverage** — CDP covers most; confirm during the Phase 1 spike.
8. **Cross-browser** — Chromium first; Firefox's CDP equivalent differs (later).
9. **Web Store policy** — an extension that records everything needs a very clear, prominent privacy disclosure.

---

## 14. Immediate Next Step

Build **Phase 0 + the Phase 1 CDP capture spike**: a bare extension that attaches `chrome.debugger` to the active tab and dumps live `Network.*` + `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded` to a JSON file. **That single spike de-risks the entire project** — if CDP gives us clean network + console + error data, everything else (media, keyframes, bundle, redaction) is standard extension work.

> Once approved, the first code deliverable is the Phase 0 skeleton + the Phase 1 CDP capture spike.
```

---

### Sources behind the upgrade
- Capture depth: [chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) · [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/) · [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) · [Log](https://chromedevtools.github.io/devtools-protocol/tot/Log/) · [DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/) · [web-vitals](https://github.com/GoogleChrome/web-vitals)
- AI-first bundle: [Anthropic Vision](https://platform.claude.com/docs/en/build-with-claude/vision) · [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Playwright MCP snapshots](https://playwright.dev/mcp/snapshots) · [Sentry Seer](https://blog.sentry.io/seer-sentrys-ai-debugger-is-generally-available/) · [W3C Trace Context](https://www.w3.org/TR/trace-context/) · [llms.txt](https://llmstxt.org/) · [Jam MCP](https://jam.dev/ai)
