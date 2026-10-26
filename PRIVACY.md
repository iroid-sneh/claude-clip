# Claude Clip — Privacy Policy

_Last updated: 2026-07-21_

Claude Clip is a browser extension that helps developers capture a bug on a web
page (video keyframes, network activity, console output, and JavaScript errors)
and turn it into a single file they can hand to an AI assistant for diagnosis.

**The short version: Claude Clip is local-first. Everything it captures stays on
your device. Claude Clip does not have a server that receives your data, does not
collect analytics, and does not sell or share your data with anyone.**

## What the extension accesses

When you press **Record** on a tab, and only after you grant the one-time
per-site permission prompt, Claude Clip captures — for that tab, for that
recording session only:

- **Network requests and responses** (URLs, headers, status codes, timing, and
  request/response bodies) via the Chrome DevTools Protocol.
- **Console output and uncaught JavaScript errors**, including stack traces.
- **Browser-internal logs** (e.g. CORS, CSP, and mixed-content warnings).
- **Tab video and audio**, and — only if you explicitly enable it — your
  **microphone** for spoken narration.
- **Your interactions on the page** (clicks, scrolls, form input, navigation)
  used to reconstruct reproduction steps.
- **Page metadata** (URL, title, viewport, browser/OS, detected framework).

Capture only runs while a recording is active. A red **REC** badge and Chrome's
own "started debugging this browser" banner are shown the entire time, so you
always know when it is on.

## Where the data goes

- All capture is stored **locally in your browser** (IndexedDB) on your machine.
- **Redaction runs on your device before anything is exported.** Common secret
  shapes (API keys, tokens, private keys, database URLs) and PII (emails, credit
  cards, SSNs) are masked, and text inputs are masked by default. Redaction is
  best-effort heuristics — review a capture before sharing it externally.
- When you choose **Export**, a single `.clip` file is saved to your computer.
  Claude Clip does not upload it anywhere. What you do with that file afterward
  (for example, giving it to an AI assistant) is your choice.

## Optional local servers (opt-in, off by default)

Claude Clip ships two optional helper servers you can run **yourself, on your own
computer**, to feed a `.clip` into a local AI coding tool:

- A **share server** and an **MCP server**, both intended to bind to
  `127.0.0.1` (localhost) only.

These run only if you start them manually from a terminal. They are not part of
the extension, are not started automatically, and send nothing to us or any
third party. If you expose them beyond localhost yourself, that is under your
control and responsibility.

## What we do NOT do

- We do **not** operate any server that receives your captured data.
- We do **not** collect usage analytics or telemetry.
- We do **not** sell, rent, or share your data with third parties.
- We do **not** use your data to train any model.

## Permissions, explained

- **`activeTab`** — read the current tab's URL when you open the popup, so we
  know which site to ask permission for.
- **`debugger`** (requested per-site at record time) — the DevTools Protocol
  access that lets us capture real network bodies and browser logs. This is why
  Chrome shows the debugging banner.
- **Host access to a site** (requested per-site at record time) — so we can
  observe that page while you record it.
- **`tabCapture`, `offscreen`** — record the tab's video/audio.
- **`storage`, `scripting`** — save captures locally and run the capture helpers.

## Data retention and deletion

Captures live in your browser's local storage until you delete them from the
Claude Clip popup or clear the extension's data. Uninstalling the extension
removes them.

## Contact

Questions about this policy can be sent to the project maintainer via the
project's public repository.
