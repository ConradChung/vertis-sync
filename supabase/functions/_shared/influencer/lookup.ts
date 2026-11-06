// Influencer LinkedIn lookup (pure): find a person's linkedin.com/in profile
// from a name, title and company with Perplexity Sonar, extract it with Haiku
// JSON, and accept it ONLY when Perplexity itself returned that URL as a
// citation / search result and the cited material ties it to the person and
// to their company or role. A URL the model typed without a citation is never
// accepted. Used by the influencer-lookup edge function.
import { buildJsonRequest, type JsonRequest } from './haiku.ts'
import { parsePerplexity, perplexityRequest } from './verify.ts'
import { PPLX_CALL_USD } from './cost.ts'

/** One lookup: one Sonar call (~$0.006) plus a small Haiku parse. The estimate shown before approval. */
export const LOOKUP_USD_PER_PERSON = 0.0065
export const MAX_LOOKUP_ATTEMPTS = 2

export interface LookupCandidate { name: string; title: string | null; company: string | null }
export interface Source { url: string; title: string; snippet: string }

const LI_RE = /^https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([^/?#\s]+)/i

/** Any linkedin.com/in/<slug> URL -> `https://www.linkedin.com/in/<slug>` (slug lowercased), else null. */
export function normalizeLinkedinUrl(raw: string | null | undefined): string | null {
  const m = LI_RE.exec((raw ?? '').trim())
  if (!m) return null
  const slug = m[1].toLowerCase()
  return slug ? `https://www.linkedin.com/in/${slug}` : null
}

const q = (s: string | null | undefined) => (s ?? '').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 200)

export function lookupQuestion(c: LookupCandidate): string {
  const who = [c.title ? `"${q(c.title)}"` : null, c.company ? `at "${q(c.company)}"` : null].filter(Boolean).join(' ')
  return (
    `Find the LinkedIn profile page (a linkedin.com/in/ URL) of the person "${q(c.name)}"${who ? `, ${who}` : ''}.\n` +
    'Cite the LinkedIn profile page itself, and say what on it (headline, current company, role) shows it is this person. ' +
    'If you cannot find their profile, say so plainly; never guess a URL.'
  )
}

export const lookupRequest = (c: LookupCandidate) => perplexityRequest(lookupQuestion(c))

export interface LookupAnswer { answer: string; sources: Source[]; cost: number }

/** Perplexity's answer, its sources (search_results with title / snippet, plus bare citations), and the call's cost. */
export function parseLookupResponse(body: unknown): LookupAnswer {
  const base = parsePerplexity(body)
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const sources: Source[] = []
  const seen = new Set<string>()
  const add = (url: unknown, title: unknown = '', snippet: unknown = '') => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    sources.push({ url, title: typeof title === 'string' ? title.slice(0, 500) : '', snippet: typeof snippet === 'string' ? snippet.slice(0, 1000) : '' })
  }
  for (const r of Array.isArray(b.search_results) ? (b.search_results as Record<string, unknown>[]) : []) add(r?.url, r?.title, r?.snippet)
  for (const c of base.citations) add(c)
  return { answer: base.answer, sources, cost: base.cost || PPLX_CALL_USD }
}

export const PARSE_SYSTEM = `You read a web-research answer about finding one person's LinkedIn profile and return strict JSON.
Rules:
- linkedin_url: copy EXACTLY one of the numbered source URLs that is that person's linkedin.com/in/ profile page, or "" if no listed
  source is. Never write a URL that is not in the list, even if the answer text mentions one.
- evidence_url: the listed source URL that best shows this profile is the right person (same name AND their company or role), or "".
- evidence_quote: a short quote (at most 200 characters) from that source's title or snippet, or from the answer, naming the person and
  their company or role; "" if none.
- reason: one sentence.`

const S = { type: 'string' }
export const PARSE_SCHEMA = {
  type: 'object',
  properties: { linkedin_url: S, evidence_url: S, evidence_quote: S, reason: S },
  required: ['linkedin_url', 'evidence_url', 'evidence_quote', 'reason'],
  additionalProperties: false,
}

export function lookupParseRequest(c: LookupCandidate, answer: string, sources: Source[]): JsonRequest {
  const user = `Person: ${q(c.name)}\nTitle: ${q(c.title)}\nCompany: ${q(c.company)}\n\nResearch answer:\n${answer.slice(0, 4000)}\n\nSources:\n` +
    sources.map((s, i) => `[${i + 1}] ${s.url} — ${s.title} — ${s.snippet}`.slice(0, 1200)).join('\n')
  return buildJsonRequest(PARSE_SYSTEM, user, PARSE_SCHEMA, 1024)
}

export interface LookupParsed { linkedin_url: string; evidence_url: string; evidence_quote: string; reason: string }

export function parseLookupJson(json: unknown): LookupParsed {
  if (!json || typeof json !== 'object') throw new Error('lookup parse: not an object')
  const j = json as Record<string, unknown>
  for (const k of ['linkedin_url', 'evidence_url', 'evidence_quote', 'reason']) {
    if (typeof j[k] !== 'string') throw new Error(`lookup parse: ${k} missing`)
  }
  const s = (k: string, max: number) => (j[k] as string).trim().slice(0, max)
  return { linkedin_url: s('linkedin_url', 500), evidence_url: s('evidence_url', 2000), evidence_quote: s('evidence_quote', 400), reason: s('reason', 1000) }
}

// ---- grounding ----

const fold = (s: string | null | undefined) =>
  (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const STOP = new Set([
  'the', 'and', 'for', 'inc', 'llc', 'ltd', 'corp', 'company', 'group', 'partners', 'real', 'estate', 'properties', 'property',
  'management', 'of', 'at', 'co', 'senior', 'head', 'lead', 'manager', 'director', 'officer', 'chief', 'vice', 'president',
])
/** Words worth matching (4+ letters, not generic). */
const words = (s: string | null | undefined) => fold(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w))
const has = (text: string, w: string) => ` ${text} `.includes(` ${w} `)

/** The person's last name (or the whole name when one word) is in the text or the profile slug. */
function nameIn(c: LookupCandidate, text: string, slug: string): boolean {
  const parts = fold(c.name).split(' ').filter((w) => w.length >= 2)
  const last = parts.at(-1)
  if (!last) return false
  return has(text, last) || slug.replace(/[^a-z0-9]/g, '').includes(last)
}
const companyIn = (c: LookupCandidate, text: string) => words(c.company).some((w) => has(text, w))
const roleIn = (c: LookupCandidate, text: string) => {
  const t = fold(c.title)
  // A role is matched by its distinctive words, or by the whole title phrase.
  return words(c.title).some((w) => has(text, w)) || (t.length >= 6 && text.includes(t))
}

export interface LookupResult {
  status: 'found' | 'not_found'
  confidence: 'high' | 'medium' | 'not_found'
  linkedin_url: string | null
  evidence: { url: string; snippet: string } | null
}

const NOT_FOUND: LookupResult = { status: 'not_found', confidence: 'not_found', linkedin_url: null, evidence: null }

/**
 * Accept the parsed URL only when it is (after normalisation) one of the
 * sources Perplexity returned, and the cited material ties it to the person:
 *  - high:   that LinkedIn result's own title / snippet names the person and
 *            their company;
 *  - medium: it names the person and their role, or a quote from another CITED
 *            source names the person with their company or role;
 *  - else not_found (no URL kept).
 */
export function groundLookup(c: LookupCandidate, p: LookupParsed, sources: Source[]): LookupResult {
  const url = normalizeLinkedinUrl(p.linkedin_url)
  if (!url) return NOT_FOUND
  const src = sources.find((s) => normalizeLinkedinUrl(s.url) === url)
  if (!src) return NOT_FOUND
  const slug = url.slice('https://www.linkedin.com/in/'.length)
  const own = fold(`${src.title} ${src.snippet}`)
  const cited = sources.find((s) => s.url === p.evidence_url)
  const quote = cited ? fold(p.evidence_quote) : ''
  const snippet = [src.title, src.snippet].filter(Boolean).join(' · ').slice(0, 500)
  if (nameIn(c, own, slug) && companyIn(c, own)) return { status: 'found', confidence: 'high', linkedin_url: url, evidence: { url: src.url, snippet } }
  if (nameIn(c, own, slug) && roleIn(c, own)) return { status: 'found', confidence: 'medium', linkedin_url: url, evidence: { url: src.url, snippet } }
  if (cited && nameIn(c, quote, slug) && (companyIn(c, quote) || roleIn(c, quote))) {
    return { status: 'found', confidence: 'medium', linkedin_url: url, evidence: { url: cited.url, snippet: p.evidence_quote.slice(0, 500) } }
  }
  return NOT_FOUND
}
