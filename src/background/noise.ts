// ─────────────────────────────────────────────────────────────────────────
// Tracking/analytics/beacon requests are captured (they're still context) but
// they shouldn't drive the diagnosis: a GA beacon aborted by an ad-blocker is
// noise, not the user's bug. This classifier lets the suspect heuristic and
// keyframe selection prefer real app requests.
// ─────────────────────────────────────────────────────────────────────────

const NOISE_HOST_PATTERNS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'g.doubleclick.net',
  'doubleclick.net',
  'stats.g.',
  'facebook.com/tr',
  'connect.facebook.net',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'hotjar.com',
  'clarity.ms',
  'sentry.io',
  'bugsnag.com',
  'fullstory.com',
  'intercom.io',
  'hs-analytics.net',
  'hubspot.com',
  'cdn.heapanalytics.com',
  'quantserve.com',
  'scorecardresearch.com',
  'bat.bing.com',
  'px.ads.linkedin.com',
  'analytics.tiktok.com',
  'snap.licdn.com',
]

const NOISE_PATH_HINTS = ['/collect', '/g/collect', '/gtm.js', '/gtag/', '/beacon', '/pixel', '/track']

export function isTrackingNoise(url: string): boolean {
  if (!url) return false
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname
    path = u.pathname
  } catch {
    host = url
    path = url
  }
  if (NOISE_HOST_PATTERNS.some((p) => host.includes(p))) return true
  // Only treat generic beacon paths as noise on non-first-party analytics hosts
  // that also look analytics-y; keep it conservative to avoid hiding real bugs.
  if (/analytics|telemetry|tracking|metrics|beacon/.test(host) && NOISE_PATH_HINTS.some((p) => path.includes(p)))
    return true
  return false
}
