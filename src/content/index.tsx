// ─────────────────────────────────────────────────────────────────────────
// Content-script entry. Owns the annotation Overlay and toggles it in response
// to SET_OVERLAY messages from the background recorder.
// ─────────────────────────────────────────────────────────────────────────

import type { ContentReadyResponse, Msg } from '@/shared/messages'
import { Overlay } from './overlay'
import { buildDomSnapshot, InteractionTracker } from './interactions'
import { initBridge, setRecording } from './main-bridge'

const overlay = new Overlay()

// Interactions are forwarded to the background to be folded into the session.
const tracker = new InteractionTracker((event) => {
  chrome.runtime.sendMessage({ type: 'ADD_INTERACTION', event } satisfies Msg).catch(() => {})
})

// Page-context errors/console (from the MAIN world) are forwarded as events.
initBridge((event) => {
  chrome.runtime.sendMessage({ type: 'ADD_EVENT', event } satisfies Msg).catch(() => {})
})

function begin(startEpoch: number): void {
  overlay.show(startEpoch)
  tracker.start(startEpoch)
  setRecording(true, startEpoch)
}

function end(): void {
  overlay.hide()
  tracker.stop()
  setRecording(false, 0)
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === 'SET_OVERLAY') {
    if (msg.active) begin(msg.startEpoch ?? Date.now())
    else end()
    sendResponse({ ok: true })
  } else if (msg.type === 'SNAPSHOT_DOM') {
    sendResponse({ ok: true, tree: buildDomSnapshot(), url: location.href })
  }
  return true
})

// On every page load, ask the background whether recording is active on this
// tab. This is what re-arms the overlay + interaction tracker after a full-page
// navigation (the previous page's content script is gone), using the ORIGINAL
// recording start so timestamps stay consistent across pages.
chrome.runtime
  .sendMessage({ type: 'CONTENT_READY' } satisfies Msg)
  .then((res: ContentReadyResponse | undefined) => {
    if (res?.active && typeof res.startEpoch === 'number') begin(res.startEpoch)
  })
  .catch(() => {})
