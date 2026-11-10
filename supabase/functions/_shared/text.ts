// Text that is safe to serialize: no lone UTF-16 surrogates (half an emoji).
// JSON.stringify writes a lone surrogate as a bare \udXXX escape, which
// Anthropic and Postgres jsonb reject ("unexpected end of hex escape",
// "Unicode low surrogate must follow a high surrogate"). A plain .slice(0, n)
// creates one whenever the cut lands inside an emoji. Mirrors lume/lib/text/wellFormed.ts.

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export const wellFormed = (s: string): string => s.replace(LONE, '')

/** Every string inside a JSON-like value, well formed (new objects; the input is untouched). */
export function deepWellFormed<T>(v: T): T {
  if (typeof v === 'string') return wellFormed(v) as T
  if (Array.isArray(v)) return v.map(deepWellFormed) as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepWellFormed(x)
    return out as T
  }
  return v
}

/** s cut to at most n UTF-16 units without splitting a surrogate pair. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return wellFormed(s)
  const end = n > 0 && /[\uD800-\uDBFF]/.test(s[n - 1]) ? n - 1 : n
  return wellFormed(s.slice(0, end))
}
