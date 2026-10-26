// ─────────────────────────────────────────────────────────────────────────
// Client-side redaction (PLAN.md §9). Runs before anything is exported or
// shared, so secrets never leave the device. Models the session-replay
// defaults: strip auth headers/cookies, scrub known secret shapes
// (gitleaks-style), and mask PII (Presidio-style: email / card / SSN).
//
// A single Redactor instance accumulates which rule classes fired, so the
// bundle can honestly report its redaction provenance.
// ─────────────────────────────────────────────────────────────────────────

// Header names whose VALUE is always sensitive (compared case-insensitively).
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  'x-goog-api-key',
])

// Query params whose value is sensitive.
const SENSITIVE_PARAMS = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'api_key',
  'apikey',
  'key',
  'password',
  'pwd',
  'secret',
  'client_secret',
  'code',
  'auth',
  'signature',
  'sig',
])

interface SecretRule {
  name: string
  re: RegExp
}

// Ordered specific → generic so the most precise label wins.
const SECRET_RULES: SecretRule[] = [
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  { name: 'aws-access-key', re: /\bA(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  { name: 'db-connection-string', re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?):\/\/[^\s"'<>]+/gi },
  { name: 'credential-assignment', re: /("?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)"?\s*[:=]\s*"?)([^\s"'&,}]{6,})/gi },
]

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g
const CARD_CANDIDATE_RE = /\b\d(?:[ -]?\d){12,18}\b/g

export class Redactor {
  readonly applied = new Set<string>()

  /** Replace a sensitive header map, keeping keys but masking flagged values. */
  headers(h?: Record<string, string>): Record<string, string> | undefined {
    if (!h) return h
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(h)) {
      if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]'
        this.applied.add(`header:${k.toLowerCase()}`)
      } else {
        out[k] = this.text(v)
      }
    }
    return out
  }

  /** Strip sensitive query-param values from a URL. */
  url(url: string): string {
    if (!url) return url
    try {
      const u = new URL(url)
      let changed = false
      for (const key of [...u.searchParams.keys()]) {
        if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
          u.searchParams.set(key, 'REDACTED')
          changed = true
        }
      }
      if (changed) this.applied.add('url-query-param')
      // Still scrub the path/rest for embedded secrets.
      return this.text(u.toString())
    } catch {
      return this.text(url)
    }
  }

  /** Scrub secrets + PII from an arbitrary string (body, message, log, stack). */
  text(s?: string): string {
    if (!s) return s ?? ''
    let out = s

    for (const rule of SECRET_RULES) {
      out = out.replace(rule.re, (...args: unknown[]) => {
        this.applied.add(`secret:${rule.name}`)
        // Rules with a capture group (credential-assignment) keep the key
        // prefix and mask only the value. Rules without a group get the match
        // offset as arg[1] (a number) — those replace the whole match.
        const prefix = args[1]
        return typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'
      })
    }

    out = out.replace(EMAIL_RE, () => {
      this.applied.add('pii:email')
      return '[REDACTED_EMAIL]'
    })

    out = out.replace(SSN_RE, () => {
      this.applied.add('pii:ssn')
      return '[REDACTED_SSN]'
    })

    out = out.replace(CARD_CANDIDATE_RE, (m) => {
      const digits = m.replace(/[ -]/g, '')
      if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
        this.applied.add('pii:credit-card')
        return '[REDACTED_CARD]'
      }
      return m
    })

    return out
  }

  provenance(): string[] {
    return [...this.applied].sort()
  }
}

function luhnValid(num: string): boolean {
  let sum = 0
  let alt = false
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}
