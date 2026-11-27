/**
 * GTM-19: the per-domain PM company check's request shapes (pure).
 *
 * `checkQuestion`, `PARSE_SYSTEM` and `PARSE_SCHEMA` are copies of
 * supabase/functions/_shared/company_check/check.ts (Turbopack's root is
 * lume/, so the Deno module cannot be imported at build time);
 * tests/hiring/checkPrompt.test.ts imports the edge module and fails when they
 * drift. The hiring check appends one question and two fields (the company's
 * main phone and website, the free contact source for the sheet) without
 * changing the job-level checker.
 */

export const PPLX_URL = 'https://api.perplexity.ai/chat/completions'
export const PPLX_MODEL = 'sonar'
export const HAIKU_MODEL = 'claude-haiku-5-5'
export const PARSE_MAX_TOKENS = 600
export const PARSE_USER_MAX_CHARS = 5_000
export const PPLX_CALL_USD = 0.006
export const HAIKU_IN_PER_M = 0.1
export const HAIKU_OUT_PER_M = 0.5

/** Kaspen's ICP for this signal: a property management company (residential or commercial rentals for owners). */
export const HIRING_ICP = 'a property management company that manages residential or commercial rental properties for owners'

export interface CheckCompany {
  company_name: string | null
  website: string | null
  company_key: string
}

const q = (s: string | null | undefined, n = 200) => (s ?? '').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, n)

/** Copy of the edge checkQuestion. */
export function checkQuestion(c: CheckCompany, icp: string): string {
  const name = q(c.company_name) || (c.company_key.startsWith('name:') ? q(c.company_key.slice(5)) : '')
  const site = q(c.website) || (c.company_key.startsWith('name:') ? '' : c.company_key)
  const who = [name ? `"${name}"` : null, site ? `(website: ${site})` : null].filter(Boolean).join(' ')
  return (
    `Research the company ${who || `"${q(c.company_key)}"`}.\n` +
    'Answer concisely with citations:\n' +
    '1. What does this company actually do: its main line of business and who its customers are?\n' +
    `2. Is it ${q(icp, 500)}? Answer yes, no or unclear, and say what on its site or in a cited source shows it.\n` +
    '3. Roughly how many doors / units / properties does it manage? Give a number if one is stated anywhere (its site, LinkedIn, a directory or an article) and say where; otherwise say unknown.\n' +
    '4. What kinds of property does it manage: single-family homes / small residential (1-4 units, condos, HOAs), multifamily apartment communities or buildings, or commercial (office, retail, industrial)? Say if it is a mix and which is the main one.\n' +
    'Keep each answer short. If you cannot find this exact company, say so plainly; do not describe a different company with a similar name.'
  )
}

export const CONTACT_QUESTION = "5. What is the company's main office phone number and its official website URL, as listed on its own site or a business directory? Say unknown if not stated."

/** Hiring-only: pins the door count in question 3 to a quoted number on a cited page (port of the signal lane's doorQuestion). */
export const DOOR_CITE_QUESTION = '6. For the door count in question 3: quote the exact number and cite the page it is on. Say unknown if no page states it.'

export const hiringCheckQuestion = (c: CheckCompany, icp = HIRING_ICP) => `${checkQuestion(c, icp)}\n${CONTACT_QUESTION}\n${DOOR_CITE_QUESTION}`

/** Port of the edge doorQuestion (_shared/influencer/verify.ts): the standalone lookup the backfill asks. */
export function doorQuestion(company: string, location: string): string {
  const clean = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 300)
  return `How many doors or units under management does the property management company "${clean(company)}" (${clean(location)}) have? Quote the exact number and cite the page.`
}

export function perplexityRequest(question: string) {
  return { model: PPLX_MODEL, messages: [{ role: 'user', content: question }], max_tokens: 600, web_search_options: { search_context_size: 'low' } }
}

/** Copy of the edge PARSE_SYSTEM. */
export const PARSE_SYSTEM = `You turn a web-research answer about one company into strict JSON.
Rules:
- what_it_does: one plain sentence (at most 200 characters) on what the company actually does and for whom, from the answer only.
  If the answer could not find the company, write "Not found".
- icp_fit: "fit" only if the answer clearly shows the company is the expected kind of business; "not_fit" if it clearly shows it is
  something else (a vendor, software, a brokerage without that service, an unrelated business); otherwise "unclear".
  Follow the expected kind of business EXACTLY as written, including any exclusions it states: if it says mainly multifamily
  or commercial-only managers are not a fit, a company whose property_type is "multifamily" or "commercial" is "not_fit".
- confidence: "high" if the company's own website (in the sources) states it, "medium" if a directory, article or profile does,
  "low" if the answer is thin, ambiguous, or the company may be a different one with a similar name.
- evidence: a short quote or paraphrase (at most 200 characters) from the answer that supports icp_fit; "" if none.
- evidence_url: copy EXACTLY the numbered source URL that supports the evidence, or "". Never write a URL not in the list.
- property_type: what it mainly manages, from the answer only. "residential" = single-family homes, small residential (1-4 units),
  condos or HOAs; "multifamily" = mainly apartment communities / buildings; "commercial" = mainly office, retail or industrial;
  "mixed" = residential plus commercial or multifamily in a meaningful share; "other" = not a property manager or something else;
  "unknown" = the answer does not say.
- doors: the number of doors / units / properties it manages as an integer if the answer states one (take the lower bound of a
  range, "500+" = 500); 0 if unknown. Never guess.
- doors_evidence: a short quote (at most 150 characters) with the door count and where it is stated; "" if doors is 0.`

export const CONTACT_RULES = `- phone: the company's main office phone number exactly as the answer states it; "" if the answer does not state one. Never guess.
- website: the company's own website URL as the answer states it; "" if none.`

export const DOOR_RULES = `- doors_source: copy EXACTLY the numbered source URL of the page that states the door count, or "". Never write a URL not in the list.
- doors_confidence: "high" if the company's own website states the count, "medium" if a directory, article or profile does, "low" if thin or ambiguous; "" if doors is 0.`

export const HIRING_PARSE_SYSTEM = `${PARSE_SYSTEM}\n${DOOR_RULES}\n${CONTACT_RULES}`

const S = { type: 'string' }
/** Copy of the edge PARSE_SCHEMA. */
export const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    what_it_does: S,
    icp_fit: { type: 'string', enum: ['fit', 'not_fit', 'unclear'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: S,
    evidence_url: S,
    property_type: { type: 'string', enum: ['residential', 'multifamily', 'commercial', 'mixed', 'other', 'unknown'] },
    doors: { type: 'integer' },
    doors_evidence: S,
  },
  required: ['what_it_does', 'icp_fit', 'confidence', 'evidence', 'evidence_url', 'property_type', 'doors', 'doors_evidence'],
  additionalProperties: false,
}

export const HIRING_PARSE_SCHEMA = {
  ...PARSE_SCHEMA,
  properties: { ...PARSE_SCHEMA.properties, doors_source: S, doors_confidence: { type: 'string', enum: ['high', 'medium', 'low', ''] }, phone: S, website: S },
  required: [...PARSE_SCHEMA.required, 'doors_source', 'doors_confidence', 'phone', 'website'],
}

export function parseRequest(c: CheckCompany, answer: string, citations: string[], icp = HIRING_ICP) {
  const head = `Company: ${q(c.company_name)}\nWebsite: ${q(c.website) || c.company_key}\nExpected kind of business: ${q(icp, 500)}\n\nResearch answer:\n`
  const sources = `\n\nSources:\n${citations.slice(0, 10).map((u, i) => `[${i + 1}] ${u.slice(0, 300)}`).join('\n')}`
  const room = Math.max(0, PARSE_USER_MAX_CHARS - head.length - sources.length)
  const user = `${head}${answer.slice(0, room)}${sources}`.slice(0, PARSE_USER_MAX_CHARS)
  return {
    model: HAIKU_MODEL,
    max_tokens: PARSE_MAX_TOKENS,
    system: HIRING_PARSE_SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: HIRING_PARSE_SCHEMA } },
    messages: [{ role: 'user', content: user }],
  }
}

export interface HiringCheck {
  icp_fit: 'fit' | 'not_fit' | 'unclear'
  property_type: string
  evidence: string
  phone: string | null
  website: string | null
  /** Units the company manages, kept only when a cited source backs it (groundDoors); else null. */
  door_count?: number | null
  door_count_source?: string | null
  door_count_confidence?: 'high' | 'medium' | 'low' | null
}

export interface GroundedDoors {
  door_count: number | null
  door_count_source: string | null
  door_count_confidence: 'high' | 'medium' | 'low' | null
}
export const NO_DOORS: GroundedDoors = { door_count: null, door_count_source: null, door_count_confidence: null }
const CONF = new Set(['high', 'medium', 'low'])

/**
 * Port of the edge groundDoorCount: a count is kept only when it is a positive
 * whole number, its source is an http(s) URL that is one of the returned
 * citations, and it has a confidence. Anything else is unknown: never a guess.
 */
export function groundDoors(json: unknown, citations: readonly string[]): GroundedDoors {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const n = j.doors
  const src = typeof j.doors_source === 'string' ? j.doors_source.trim() : ''
  const conf = typeof j.doors_confidence === 'string' ? j.doors_confidence.trim() : ''
  const ok = typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 1_000_000 && /^https?:\/\//i.test(src) && citations.includes(src) && CONF.has(conf)
  return ok ? { door_count: Math.floor(n), door_count_source: src.slice(0, 300), door_count_confidence: conf as 'high' | 'medium' | 'low' } : NO_DOORS
}

const FITS = new Set(['fit', 'not_fit', 'unclear'])
const PHONE = /^\+?[\d\s().-]{7,25}(\s*(x|ext\.?)\s*\d{1,6})?$/i

/** The parsed JSON → the fields the signal keeps. Throws on a bad icp_fit. A phone must look like one, else dropped. */
export function parseHiringCheck(json: unknown, citations: readonly string[] = []): HiringCheck {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const s = (k: string, n: number) => (typeof j[k] === 'string' ? (j[k] as string).trim().slice(0, n) : '')
  const fit = s('icp_fit', 20)
  if (!FITS.has(fit)) throw new Error(`check parse: bad icp_fit ${fit}`)
  const phone = s('phone', 40)
  const website = s('website', 300)
  return {
    icp_fit: fit as HiringCheck['icp_fit'],
    property_type: s('property_type', 20) || 'unknown',
    evidence: s('evidence', 300) || s('what_it_does', 300),
    phone: phone && PHONE.test(phone) && (phone.match(/\d/g) ?? []).length >= 7 ? phone : null,
    website: /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(website) ? website : null,
    ...groundDoors(json, citations),
  }
}

/** The backfill's own Haiku parse: just the count, its source and confidence. */
export const DOOR_PARSE_SCHEMA = {
  type: 'object',
  properties: { doors: { type: 'integer' }, doors_source: S, doors_confidence: { type: 'string', enum: ['high', 'medium', 'low', ''] } },
  required: ['doors', 'doors_source', 'doors_confidence'],
  additionalProperties: false,
}
export const DOOR_PARSE_SYSTEM = `You turn a web-research answer about one property management company into strict JSON.\nRules:\n- doors: the number of doors / units / properties it manages as an integer if the answer states one (take the lower bound of a range, "500+" = 500); 0 if unknown. Never guess.\n${DOOR_RULES}\nIf the answer is about a different company than the one named, doors is 0.`

export function doorParseRequest(company: string, answer: string, citations: string[]) {
  const head = `Company: ${q(company)}\n\nResearch answer:\n`
  const sources = `\n\nSources:\n${citations.slice(0, 10).map((u, i) => `[${i + 1}] ${u.slice(0, 300)}`).join('\n')}`
  const room = Math.max(0, PARSE_USER_MAX_CHARS - head.length - sources.length)
  return {
    model: HAIKU_MODEL,
    max_tokens: 200,
    system: DOOR_PARSE_SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: DOOR_PARSE_SCHEMA } },
    messages: [{ role: 'user', content: `${head}${answer.slice(0, room)}${sources}`.slice(0, PARSE_USER_MAX_CHARS) }],
  }
}

/** Real Haiku cost from usage tokens. */
export const haikuUsd = (u: { input_tokens?: number; output_tokens?: number } | null | undefined) =>
  ((u?.input_tokens ?? 0) * HAIKU_IN_PER_M + (u?.output_tokens ?? 0) * HAIKU_OUT_PER_M) / 1_000_000
