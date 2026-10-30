// Verification of model-extracted facts (research P2). Pure.
//
// A candidate is kept only when ALL hold:
//   - field is one of door_count | after_hours | city | region | country
//   - confidence is high | medium | low
//   - source_url is one of the crawled pages (compared without fragment and
//     trailing slash; the crawled page's own URL is what gets stored)
//   - the snippet, whitespace-normalized, occurs verbatim (case-sensitive) in
//     that page's whitespace-normalized text
//   - the value is well-formed for its field: door_count a positive integer
//     (<= 1,000,000) that appears as a number in the snippet; after_hours a
//     boolean; city / region a short string that appears in the snippet
//     (case-insensitive); country a short string (it may be inferred, e.g.
//     from a province, so it is not required in the snippet)
// Then one value per field: highest confidence, then first.
// Everything else is dropped with a reason, for the crawl's extraction log.
//
// door_count copy_value (the number copy may print), rounded DOWN:
//   n < 10        -> n            (7 -> 7)
//   10 <= n < 100 -> whole tens   (87 -> 80)
//   n >= 100      -> two significant figures (350 -> 350, 1,237 -> 1,200,
//                    12,345 -> 12,000)
// Rounding down keeps "over N doors" true.

import type { Confidence, Page } from './pms.ts'

export const EXTRACT_FIELDS = ['door_count', 'after_hours', 'city', 'region', 'country'] as const
export type ExtractField = typeof EXTRACT_FIELDS[number]

export interface Candidate {
  field: ExtractField
  value: unknown
  confidence: Confidence
  snippet: string
  source_url: string
}

export interface VerifiedFact {
  field: ExtractField
  value: number | boolean | string
  copy_value: number | null
  confidence: Confidence
  snippet: string
  source_url: string
}

export type DropReason =
  | 'unknown_field'
  | 'bad_confidence'
  | 'empty_snippet'
  | 'source_not_crawled'
  | 'snippet_not_on_page'
  | 'bad_value'
  | 'value_not_in_snippet'
  | 'duplicate_field'

export interface Dropped { field: string; reason: DropReason; source_url: string | null }

export const MAX_DOORS = 1_000_000
const MAX_SNIPPET = 1000
const MAX_PLACE = 100
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function doorCountCopyValue(n: number): number {
  if (n < 10) return n
  if (n < 100) return Math.floor(n / 10) * 10
  const step = 10 ** (Math.floor(Math.log10(n)) - 1)
  return Math.floor(n / step) * step
}

export function parseDoorCount(v: unknown): number | null {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string') {
    const s = v.trim().replace(/\+$/, '').replace(/[,\s]/g, '')
    if (!/^\d+$/.test(s)) return null
    n = Number(s)
  } else return null
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_DOORS ? n : null
}

/** Numbers written in the snippet: 1237, 1,237, 1 237, 1.237 all read as 1237. */
function numbersIn(snippet: string): number[] {
  return (snippet.match(/\d{1,3}(?:[,\s.]\d{3})+|\d+/g) ?? []).map((t) => Number(t.replace(/[,\s.]/g, '')))
}

function pageKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.toString().replace(/\/+$/, '')
  } catch {
    return url.trim().replace(/#.*$/, '').replace(/\/+$/, '')
  }
}

function placeOk(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= MAX_PLACE
}

export function verifyCandidates(candidates: Candidate[], pages: Page[]): { kept: VerifiedFact[]; dropped: Dropped[] } {
  const byUrl = new Map<string, { url: string; text: string }>()
  for (const p of pages) {
    const k = pageKey(p.url)
    if (!byUrl.has(k)) byUrl.set(k, { url: p.url, text: normalizeWs(p.text ?? '') })
  }

  const dropped: Dropped[] = []
  const passing: Array<{ fact: VerifiedFact; order: number }> = []

  candidates.forEach((c, order) => {
    const src = typeof c.source_url === 'string' ? c.source_url : null
    const drop = (reason: DropReason) => dropped.push({ field: String(c.field), reason, source_url: src })

    if (!(EXTRACT_FIELDS as readonly string[]).includes(c.field)) return drop('unknown_field')
    if (!(c.confidence in RANK)) return drop('bad_confidence')
    const snippet = normalizeWs(typeof c.snippet === 'string' ? c.snippet : '')
    if (!snippet) return drop('empty_snippet')
    if (snippet.length > MAX_SNIPPET) return drop('snippet_not_on_page')
    const page = src ? byUrl.get(pageKey(src)) : undefined
    if (!page) return drop('source_not_crawled')
    if (!page.text.includes(snippet)) return drop('snippet_not_on_page')

    let value: number | boolean | string
    let copy: number | null = null
    switch (c.field) {
      case 'door_count': {
        const n = parseDoorCount(c.value)
        if (n === null) return drop('bad_value')
        if (!numbersIn(snippet).includes(n)) return drop('value_not_in_snippet')
        value = n
        copy = doorCountCopyValue(n)
        break
      }
      case 'after_hours':
        if (typeof c.value !== 'boolean') return drop('bad_value')
        value = c.value
        break
      case 'city':
      case 'region':
        if (!placeOk(c.value)) return drop('bad_value')
        value = normalizeWs(c.value)
        if (!snippet.toLowerCase().includes(value.toLowerCase())) return drop('value_not_in_snippet')
        break
      case 'country':
        if (!placeOk(c.value)) return drop('bad_value')
        value = normalizeWs(c.value)
        break
    }
    passing.push({
      fact: { field: c.field, value, copy_value: copy, confidence: c.confidence, snippet, source_url: page.url },
      order,
    })
  })

  const kept: VerifiedFact[] = []
  for (const field of EXTRACT_FIELDS) {
    const group = passing.filter((p) => p.fact.field === field)
      .sort((a, b) => RANK[a.fact.confidence] - RANK[b.fact.confidence] || a.order - b.order)
    if (!group.length) continue
    kept.push(group[0].fact)
    for (const g of group.slice(1)) dropped.push({ field, reason: 'duplicate_field', source_url: g.fact.source_url })
  }
  // Keep the caller's order for kept facts.
  kept.sort((a, b) => passing.findIndex((p) => p.fact === a) - passing.findIndex((p) => p.fact === b))
  return { kept, dropped }
}
