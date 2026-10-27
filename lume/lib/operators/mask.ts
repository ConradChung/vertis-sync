/**
 * Operator sign-in links (`…/auth/operator?k=<raw key>`) must never be stored
 * in plaintext. A raw key is 32 random bytes in base64url: exactly 43
 * characters. `maskOperatorKeys` keeps the first 4: `?k=abcd****`.
 *
 * Only the sign-in path is matched (plain or URL-encoded), so any other
 * `?k=` — an Amazon search URL in an Apify input, sequence copy, a webhook
 * payload — is left exactly as it was. With `{ bare: true }` a standalone
 * 43-character base64url token is masked too; that is for agent-written text
 * only (messages, runs, memory, skills, titles), never pending_actions
 * payloads or events, which may carry legitimate tokens of that shape.
 * Pure; strings or any JSON value (deep).
 */

export interface MaskOptions {
  /** Also mask a bare 43-character base64url token (agent text only). */
  bare?: boolean
}

const SIGN_IN_KEY = /((?:\/|%2F)auth(?:\/|%2F)operator(?:\?|%3F)(?:[^#\s]*?(?:&|%26))?k(?:=|%3D))([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/gi
const BARE_KEY = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g

export function maskKeyText(s: string, opts: MaskOptions = {}): string {
  let out = s.replace(SIGN_IN_KEY, (_m, pre: string, key: string) => `${pre}${key.slice(0, 4)}****`)
  if (opts.bare) out = out.replace(BARE_KEY, (_m, key: string) => `${key.slice(0, 4)}****`)
  return out
}

export function maskOperatorKeys<T>(value: T, opts: MaskOptions = {}): T {
  if (typeof value === 'string') return maskKeyText(value, opts) as T
  if (Array.isArray(value)) return value.map((v) => maskOperatorKeys(v, opts)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskOperatorKeys(v, opts)
    return out as T
  }
  return value
}
