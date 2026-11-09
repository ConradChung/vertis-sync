/**
 * Lone UTF-16 surrogates (half an emoji — from a source that clipped text, or
 * our own `.slice()`) are valid in a JS string but not in JSON, so Postgres
 * refuses the whole jsonb insert ("Unicode low surrogate must follow a high
 * surrogate"; load_actor_results 500, 2026-11-09). Drop them before saving.
 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export const wellFormed = (s: string): string => s.replace(LONE, '')

/** The same through arrays and plain objects (keys too); other values untouched. */
export function deepWellFormed<T>(v: T): T {
  if (typeof v === 'string') return wellFormed(v) as T
  if (Array.isArray(v)) return v.map(deepWellFormed) as T
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[wellFormed(k)] = deepWellFormed(x)
    return out as T
  }
  return v
}

/** `s.slice(0, n)` that never ends on half a surrogate pair. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}
