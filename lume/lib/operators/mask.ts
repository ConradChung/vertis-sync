/**
 * Operator sign-in links (`…/auth/operator?k=<raw key>`) must never be stored
 * in plaintext. Everything Lume persists that could carry one (agent
 * messages and runs, pending_actions result, events) passes through
 * `maskOperatorKeys`, which keeps the first 4 key characters: `?k=abcd****`.
 * Pure; works on strings and any JSON value (deep).
 */

const KEY_IN_URL = /([?&]k=)([A-Za-z0-9_%-]+)(\*{4})?/g

export function maskKeyText(s: string): string {
  if (!s.includes('k=')) return s
  // Already masked (`abcd****`) stays as it is.
  return s.replace(KEY_IN_URL, (m, pre: string, key: string, stars?: string) => (stars ? m : `${pre}${key.slice(0, 4)}****`))
}

export function maskOperatorKeys<T>(value: T): T {
  if (typeof value === 'string') return maskKeyText(value) as T
  if (Array.isArray(value)) return value.map((v) => maskOperatorKeys(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskOperatorKeys(v)
    return out as T
  }
  return value
}
