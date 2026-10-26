import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Claude Clip',
  version: '0.1.0',
  description:
    'Record a bug on any site; Claude diagnoses it from one link. Captures video keyframes, network (with bodies), console & errors via the DevTools Protocol.',
  action: {
    default_popup: 'index.html',
    default_title: 'Claude Clip',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.tsx'],
      run_at: 'document_idle',
      all_frames: false,
    },
    {
      // Runs in the page's own JS context to read React/Vue components and trap
      // page-level errors. Passive until the recorder activates it.
      matches: ['<all_urls>'],
      js: ['src/content/main-world.ts'],
      run_at: 'document_start',
      all_frames: false,
      world: 'MAIN',
    },
  ],
  // `debugger` MUST be a required permission — Chrome refuses to grant it as
  // optional and silently omits it (breaking capture). It's the one unavoidable
  // install-time warning. Everything else stays minimal: `activeTab` reads only
  // the CURRENT tab's URL when the popup opens (to know which origin to ask for)
  // and triggers no scary warning.
  permissions: ['debugger', 'activeTab', 'storage', 'scripting', 'tabCapture', 'offscreen'],
  // Cross-site host access is requested per-origin at RECORD time from the
  // popup's user gesture ("Allow Claude Clip on example.com?", see
  // ensureCapturePermission) instead of for every site at install.
  optional_host_permissions: ['<all_urls>'],
  // world:'MAIN' content scripts (111+), offscreen (109+), tabCapture.getMediaStreamId.
  minimum_chrome_version: '116',
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
})
