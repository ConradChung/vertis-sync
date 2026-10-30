// Verification of model-extracted facts (research P2). Pure.
//
// A candidate is kept only when ALL hold:
//   - field is one of door_count | after_hours | city | region | country
//   - confidence is high | medium | low
//   - source_url is one of the crawled pages (compared without fragment and
//     trailing slash; the crawled page's own URL is what gets stored)
//   - the snippet, whitespace-normalized, occurs verbatim (case-sensitive) in
//     that page's whitespace-normalized text
//   - the value is well-formed AND supported by its snippet:
//       door_count  a positive integer (<= 1,000,000) written in the snippet
//                   with a unit word (doors / units / homes / rentals /
//                   apartments; not "properties", a building count) within 3
//                   words after or before it, in the same sentence (. ! ? |
//                   end the window), so "Since 1998", "a team of 25" or
//                   "Founded in 1998. Units available" never count
//       after_hours a boolean, and the snippet carries after-hours-specific
//                   phrasing: after-hours, 24/7, 24 hours, emergency
//                   maintenance/line/repairs, on-call, answering service, or
//                   "evenings and weekends" together with maintenance/repairs
//                   (bare "nights" or "emergency" do not count)
//       city        a short string named in the snippet (whole word, case-insensitive,
//                   not the tail of a longer place: "York" is not in "New York")
//       region      a 2-letter code only as a standalone upper-case token not next
//                   to other all-caps words ("Toronto, ON M5V" yes, "Contact our"
//                   or "ON SALE" no); a full name whole-word as for city
//       country     named in the snippet (full name, whole word; no adjectives or
//                   sub-regions like "British" or "America"; short aliases like
//                   "US" only as standalone upper-case tokens, so "Contact us" and
//                   "ABOUT US | CONTACT US" are not the United States), or derived
//                   from the kept region (itself matched as above)
//                   (BC -> Canada, TX -> United States; see geo.ts). Stored as
//                   the canonical English name.
// Then one value per field: highest confidence, then first; kept facts come
// back in field order (door_count, after_hours, city, region, country).
// Everything else is dropped with a reason, for the crawl's extraction log.
//
// door_count copy_value (the number copy may print), rounded DOWN:
//   n < 10        -> n            (7 -> 7)
//   10 <= n < 100 -> whole tens   (87 -> 80)
//   n >= 100      -> two significant figures (350 -> 350, 1,237 -> 1,200,
//                    12,345 -> 12,000)
// Rounding down keeps "over N doors" true.

import { canonicalCountry, countryInText, placeInText, regionCountry, regionInText } from './geo.ts'
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
  | 'no_unit_word'
  | 'no_after_hours_keyword'
  | 'country_not_supported'
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

// Not "properties": a building count ("40 properties totaling 2,400 units") is not a door count.
const UNIT_WORD = /^(doors?|units?|homes?|rentals?|apartments?)$/i
/** Sentence / separator punctuation ends a unit window ("Founded in 1998. Units available"). */
const SENTENCE_END = /^[.!?|]$/
const UNIT_WINDOW = 3
// After-hours-specific phrasing only: bare "nights", "overnight" or "emergency"
// also appear in showing hours, parking and fire-exit text.
const AFTER_HOURS = [
  /\bafter[\s-]?hours\b/i,
  /\b24\s*\/\s*7\b/,
  /\b24[\s-]*(hours?|hrs?)\b/i,
  /\bemergency\s+(maintenance|line|repairs?|service|number|hotline|calls?|requests?)\b/i,
  /\bon[\s-]?call\b/i,
  /\banswering service\b/i,
]
const EVENINGS_WEEKENDS = /\bevenings?\s+(and|&)\s+weekends?\b/i
const MAINTENANCE = /\b(maintenance|repairs?|emergenc(y|ies))\b/i

/**
 * True when `n` is written in the snippet with a unit word next to it: within
 * UNIT_WINDOW words after it ("1,237 doors", "350 residential rental units"),
 * or, when no word follows the number, within UNIT_WINDOW words before it
 * ("Doors under management: 2,400"). Another number ends the window, so
 * "a team of 25 handles 350 units" does not make 25 a door count.
 */
export function doorCountHasUnit(snippet: string, n: number): boolean {
  type Tok = { kind: 'num' | 'word' | 'punct'; text: string }
  const toks: Tok[] = []
  for (const m of snippet.matchAll(/(\d{1,3}(?:[,\s.]\d{3})+|\d+)|([A-Za-z]+)|([^\sA-Za-z\d])/g)) {
    toks.push({ kind: m[1] ? 'num' : m[2] ? 'word' : 'punct', text: m[0] })
  }
  const windowWords = (from: number, step: 1 | -1) => {
    const words: string[] = []
    for (let i = from; i >= 0 && i < toks.length && words.length < UNIT_WINDOW; i += step) {
      if (toks[i].kind === 'num' || SENTENCE_END.test(toks[i].text)) break
      if (toks[i].kind === 'word') words.push(toks[i].text)
    }
    return words
  }
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].kind !== 'num' || Number(toks[i].text.replace(/[,\s.]/g, '')) !== n) continue
    let j = i + 1
    while (j < toks.length && toks[j].text === '+') j++
    if (windowWords(j, 1).some((w) => UNIT_WORD.test(w))) return true
    const followedByWord = j < toks.length && toks[j].kind === 'word'
    if (!followedByWord && windowWords(i - 1, -1).some((w) => UNIT_WORD.test(w))) return true
  }
  return false
}

export function hasAfterHoursKeyword(snippet: string): boolean {
  if (AFTER_HOURS.some((re) => re.test(snippet))) return true
  // "evenings and weekends" only counts for maintenance, not office or showing hours.
  return EVENINGS_WEEKENDS.test(snippet) && MAINTENANCE.test(snippet)
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
  // Countries are checked after the region is chosen (they may be derived from it).
  const countries: Array<{ fact: VerifiedFact; order: number; inText: boolean; src: string | null }> = []

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
        if (!doorCountHasUnit(snippet, n)) return drop('no_unit_word')
        value = n
        copy = doorCountCopyValue(n)
        break
      }
      case 'after_hours':
        if (typeof c.value !== 'boolean') return drop('bad_value')
        if (!hasAfterHoursKeyword(snippet)) return drop('no_after_hours_keyword')
        value = c.value
        break
      case 'city':
      case 'region':
        if (!placeOk(c.value)) return drop('bad_value')
        value = normalizeWs(c.value)
        if (!(c.field === 'region' ? regionInText(value, snippet) : placeInText(value, snippet))) return drop('value_not_in_snippet')
        break
      case 'country': {
        if (!placeOk(c.value)) return drop('bad_value')
        const name = canonicalCountry(c.value) ?? normalizeWs(c.value)
        countries.push({
          fact: { field: 'country', value: name, copy_value: null, confidence: c.confidence, snippet, source_url: page.url },
          order,
          inText: countryInText(name, snippet),
          src,
        })
        return
      }
    }
    passing.push({
      fact: { field: c.field, value, copy_value: copy, confidence: c.confidence, snippet, source_url: page.url },
      order,
    })
  })

  const best = (field: ExtractField) =>
    passing.filter((p) => p.fact.field === field)
      .sort((a, b) => RANK[a.fact.confidence] - RANK[b.fact.confidence] || a.order - b.order)[0]?.fact
  const region = best('region')
  const regionsCountry = region ? regionCountry(String(region.value)) : null
  for (const k of countries) {
    if (k.inText || (regionsCountry !== null && regionsCountry === k.fact.value)) passing.push({ fact: k.fact, order: k.order })
    else dropped.push({ field: 'country', reason: 'country_not_supported', source_url: k.src })
  }

  const kept: VerifiedFact[] = []
  for (const field of EXTRACT_FIELDS) {
    const group = passing.filter((p) => p.fact.field === field)
      .sort((a, b) => RANK[a.fact.confidence] - RANK[b.fact.confidence] || a.order - b.order)
    if (!group.length) continue
    kept.push(group[0].fact)
    for (const g of group.slice(1)) dropped.push({ field, reason: 'duplicate_field', source_url: g.fact.source_url })
  }
  return { kept, dropped }
}
