// Stage 6: Perplexity Sonar verification (is this a decision maker at a PM
// company; company, website, location, door count with citations), parsed to
// JSON by Haiku; then a targeted door-count retry for verified rows without
// one. Pure. Ported from pm/verify.py.
//
// door_count is kept only when a cited source states it: its source must be
// one of the citations Perplexity returned, and it needs a confidence
// (high = the company's own site, medium = a directory / article / interview,
// low = only the headline or a vague phrase).
import { buildJsonRequest, type JsonRequest } from './haiku.ts'
import { PPLX_CALL_USD } from './cost.ts'

export const PPLX_URL = 'https://api.perplexity.ai/chat/completions'
export const PPLX_MODEL = 'sonar'
/** Perplexity 429s above ~2 concurrent requests. */
export const VERIFY_WORKERS = 2
export const RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000]
export const MAX_VERIFY_ATTEMPTS = 2

export function perplexityRequest(question: string) {
  return {
    model: PPLX_MODEL,
    messages: [{ role: 'user', content: question }],
    max_tokens: 600,
    web_search_options: { search_context_size: 'low' },
  }
}

export const retryable = (status: number) => status === 429 || (status >= 500 && status < 600)

export interface PplxAnswer { answer: string; citations: string[]; cost: number }

export function parsePerplexity(body: unknown): PplxAnswer {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const choices = Array.isArray(b.choices) ? b.choices as Array<{ message?: { content?: unknown } }> : []
  const answer = choices[0]?.message?.content
  if (typeof answer !== 'string') throw new Error('perplexity: no answer')
  const citations = Array.isArray(b.citations) ? (b.citations as unknown[]).filter((c): c is string => typeof c === 'string') : []
  const cost = Number(((b.usage as Record<string, unknown> | undefined)?.cost as Record<string, unknown> | undefined)?.total_cost)
  return { answer, citations, cost: Number.isFinite(cost) && cost > 0 ? cost : PPLX_CALL_USD }
}

const q = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 300)

export function verificationQuestion(name: string, headline: string): string {
  return (
    `Research the LinkedIn user "${q(name)}" whose headline is "${q(headline)}".\n` +
    'Answer concisely with citations:\n' +
    '1. What is their current company and website?\n' +
    '2. Does that company manage rental properties for third-party owners (property management)?\n' +
    '3. What is their exact title there, and are they the owner/founder/CEO/principal?\n' +
    '4. How many doors or units under management does the company state? Quote the number and source.\n' +
    '5. Where is the company located (city, state or region, country)?\n' +
    'If you cannot find the person or company, say so plainly.'
  )
}

export function doorQuestion(company: string, location: string): string {
  return `How many doors or units under management does the property management company "${q(company)}" (${q(location)}) have? Quote the exact number and cite the page.`
}

export const PARSE_SYSTEM = `You turn a web-research answer about a person into strict JSON.
Rules:
- is_pm_company: true only if the person's current company manages rental properties for third-party
  owners (residential or commercial property management, including brokerages with a PM division).
  Vendors, software, coaches, consultants, and pure investors are false.
- is_decision_maker: true only for owner, founder, co-founder, CEO, president, principal,
  broker-owner, managing partner, managing broker, managing director, or equivalent.
- company_website: the company's own website URL, or "".
- location: the company's location as written; city, state, country: its parts ("" when unknown;
  state as written, country as a full English name).
- door_count: the number of doors/units/properties under management, as an integer, only if the
  answer states a number for THIS company. Otherwise null. Ranges: use the lower bound.
- door_count_source: the URL from the answer's citations that states the number, else "".
- door_count_confidence: "high" if the company's own website states it, "medium" if a directory,
  article, or interview states it, "low" if only the headline or a vague phrase implies it, "" if null.
- reason: one sentence.`

const S = { type: 'string' }
export const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    is_pm_company: { type: 'boolean' },
    is_decision_maker: { type: 'boolean' },
    title: S, company_name: S, company_website: S, location: S, city: S, state: S, country: S,
    door_count: { type: ['integer', 'null'] },
    door_count_source: S,
    door_count_confidence: { type: 'string', enum: ['high', 'medium', 'low', ''] },
    reason: S,
  },
  required: ['is_pm_company', 'is_decision_maker', 'title', 'company_name', 'company_website', 'location', 'city', 'state', 'country',
    'door_count', 'door_count_source', 'door_count_confidence', 'reason'],
  additionalProperties: false,
}

export function verifyParseRequest(name: string, headline: string, answer: string, citations: string[]): JsonRequest {
  const user = `Person: ${name}\nHeadline: ${headline}\n\nResearch answer:\n${answer}\n\nCitations:\n` +
    citations.map((c, i) => `[${i + 1}] ${c}`).join('\n')
  return buildJsonRequest(PARSE_SYSTEM, user, PARSE_SCHEMA, 2048)
}

export interface Parsed {
  is_pm_company: boolean
  is_decision_maker: boolean
  title: string
  company_name: string
  company_website: string
  location: string
  city: string
  state: string
  country: string
  door_count: number | null
  door_count_source: string
  door_count_confidence: '' | 'high' | 'medium' | 'low'
  reason: string
}

const CONF = new Set(['', 'high', 'medium', 'low'])

export function parseVerifyJson(json: unknown): Parsed {
  if (!json || typeof json !== 'object') throw new Error('verify parse: not an object')
  const j = json as Record<string, unknown>
  if (typeof j.is_pm_company !== 'boolean' || typeof j.is_decision_maker !== 'boolean') throw new Error('verify parse: booleans missing')
  const s = (k: string, max = 300) => (typeof j[k] === 'string' ? (j[k] as string).trim().slice(0, max) : '')
  const conf = s('door_count_confidence')
  if (!CONF.has(conf)) throw new Error(`verify parse: bad confidence ${conf}`)
  const dc = j.door_count === null || j.door_count === undefined ? null : Number(j.door_count)
  return {
    is_pm_company: j.is_pm_company,
    is_decision_maker: j.is_decision_maker,
    title: s('title'),
    company_name: s('company_name'),
    company_website: s('company_website', 500),
    location: s('location'),
    city: s('city', 120),
    state: s('state', 120),
    country: s('country', 120),
    door_count: dc === null || !Number.isFinite(dc) ? null : Math.floor(dc),
    door_count_source: s('door_count_source', 2000),
    door_count_confidence: conf as Parsed['door_count_confidence'],
    reason: s('reason', 2000),
  }
}

/** Keep door_count only when its source is one of the returned citations and it has a confidence. */
export function groundDoorCount<T extends Pick<Parsed, 'door_count' | 'door_count_source' | 'door_count_confidence'>>(parsed: T, citations: string[]): T {
  const src = (parsed.door_count_source ?? '').trim()
  const ok = parsed.door_count !== null && parsed.door_count >= 0 && !!src && /^https?:\/\//i.test(src) &&
    citations.includes(src) && parsed.door_count_confidence !== ''
  return ok ? parsed : { ...parsed, door_count: null, door_count_source: '', door_count_confidence: '' }
}

export const verdict = (p: Pick<Parsed, 'is_pm_company' | 'is_decision_maker'>): 'verified' | 'rejected' =>
  p.is_pm_company && p.is_decision_maker ? 'verified' : 'rejected'

/** Candidates (likely / possible) never verified, or errored fewer than MAX_VERIFY_ATTEMPTS times. */
export function verifyTodo<T extends { triage: string | null; verdict: string | null; verify_attempts: number }>(rows: T[]): T[] {
  return rows.filter((r) => (r.triage === 'likely' || r.triage === 'possible') &&
    (r.verdict === null || (r.verdict === 'error' && r.verify_attempts < MAX_VERIFY_ATTEMPTS)))
}

/** Verified rows still worth a door retry: no count, a company to ask about, not retried. */
export function doorRetryTodo<T extends { verdict: string | null; door_count: number | null; company_name: string | null; door_retried: boolean }>(rows: T[]): T[] {
  return rows.filter((r) => r.verdict === 'verified' && r.door_count === null && !!(r.company_name ?? '').trim() && !r.door_retried)
}
