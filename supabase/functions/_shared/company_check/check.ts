// Company check (pure): what a company really does, what kind of property it
// manages (residential / multifamily / commercial / mixed), roughly how many
// doors, and whether it fits the ICP, all from ONE Perplexity Sonar call (the
// same request shape and price as the influencer verify step) parsed to strict JSON by Haiku. Used by the
// company-check edge function; Lume mirrors the unit price in
// lume/lib/companyCheck/model.ts (a parity test keeps them equal).
//
// Price per company, every term from code:
//   Perplexity  PPLX_CALL_USD ($0.006, _shared/influencer/cost.ts) for one
//               perplexityRequest (_shared/influencer/verify.ts: model sonar,
//               search_context_size low, max_tokens 600). The run tallies the
//               real usage.cost.total_cost when Perplexity returns it.
//   Haiku       HAIKU_MODEL (_shared/influencer/haiku.ts) at HAIKU_IN_PER_M /
//               HAIKU_OUT_PER_M (cost.ts), priced at a ceiling: input tokens
//               <= the characters sent (system + schema + the user message,
//               which is clipped to PARSE_USER_MAX_CHARS) + a fixed allowance
//               for the structured-output wrapper; output tokens <=
//               PARSE_MAX_TOKENS. The run tallies the real usage tokens.
import { buildJsonRequest, HAIKU_MODEL, type JsonRequest } from '../influencer/haiku.ts'
import { HAIKU_IN_PER_M, HAIKU_OUT_PER_M, PPLX_CALL_USD } from '../influencer/cost.ts'
import { parsePerplexity, perplexityRequest } from '../influencer/verify.ts'

export { HAIKU_MODEL }

export const PARSE_MAX_TOKENS = 512
/** The user message (company + answer + citations) is clipped to this many characters. */
export const PARSE_USER_MAX_CHARS = 5_000
/** Tokens allowed for the structured-output wrapper on top of the characters we send. */
export const STRUCTURED_OUTPUT_ALLOWANCE_TOKENS = 500
export const MAX_CHECK_ATTEMPTS = 2
/** One approval may add at most this much to a run's cap. */
export const MAX_APPROVAL_USD = 50

export interface CheckCompany { company_name: string | null; website: string | null; company_key: string }

const q = (s: string | null | undefined, n = 200) => (s ?? '').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, n)

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

export const checkRequest = (c: CheckCompany, icp: string) => perplexityRequest(checkQuestion(c, icp))

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

const S = { type: 'string' }
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

export function checkParseRequest(c: CheckCompany, icp: string, answer: string, citations: string[]): JsonRequest {
  const head = `Company: ${q(c.company_name)}\nWebsite: ${q(c.website) || c.company_key}\nExpected kind of business: ${q(icp, 500)}\n\nResearch answer:\n`
  const sources = `\n\nSources:\n${citations.slice(0, 10).map((u, i) => `[${i + 1}] ${u.slice(0, 300)}`).join('\n')}`
  const room = Math.max(0, PARSE_USER_MAX_CHARS - head.length - sources.length)
  const user = `${head}${answer.slice(0, room)}${sources}`.slice(0, PARSE_USER_MAX_CHARS)
  return buildJsonRequest(PARSE_SYSTEM, user, PARSE_SCHEMA, PARSE_MAX_TOKENS)
}

/** The Haiku ceiling per company: every character sent counts as a token, plus the wrapper allowance; full max_tokens out. */
export function haikuCeilingUsd(): number {
  const inputTokens = PARSE_SYSTEM.length + JSON.stringify(PARSE_SCHEMA).length + PARSE_USER_MAX_CHARS + STRUCTURED_OUTPUT_ALLOWANCE_TOKENS
  return (inputTokens * HAIKU_IN_PER_M + PARSE_MAX_TOKENS * HAIKU_OUT_PER_M) / 1_000_000
}

/** The per-company price quoted before approval (rounded up to $0.00001). */
export const CHECK_USD_PER_COMPANY = Math.ceil((PPLX_CALL_USD + haikuCeilingUsd()) * 100_000 - 1e-9) / 100_000

export interface CheckResult {
  what_it_does: string
  icp_fit: 'fit' | 'not_fit' | 'unclear'
  confidence: 'high' | 'medium' | 'low'
  evidence: string
  evidence_url: string | null
  property_type: PropertyType
  /** null = unknown (the model's 0). */
  doors: number | null
  doors_evidence: string
}

export const PROPERTY_TYPES = ['residential', 'multifamily', 'commercial', 'mixed', 'other', 'unknown'] as const
export type PropertyType = typeof PROPERTY_TYPES[number]
/** A door count above this is treated as a parse error and stored as unknown. */
export const MAX_DOORS = 1_000_000

const FITS = new Set(['fit', 'not_fit', 'unclear'])
const CONFS = new Set(['high', 'medium', 'low'])
const TYPES = new Set<string>(PROPERTY_TYPES)

export function parseCheckJson(json: unknown): CheckResult {
  if (!json || typeof json !== 'object') throw new Error('check parse: not an object')
  const j = json as Record<string, unknown>
  const s = (k: string, n: number) => (typeof j[k] === 'string' ? (j[k] as string).trim().slice(0, n) : '')
  const fit = s('icp_fit', 20)
  const conf = s('confidence', 20)
  if (!FITS.has(fit)) throw new Error(`check parse: bad icp_fit ${fit}`)
  if (!CONFS.has(conf)) throw new Error(`check parse: bad confidence ${conf}`)
  const what = s('what_it_does', 1000)
  if (!what) throw new Error('check parse: what_it_does missing')
  const type = s('property_type', 20) || 'unknown'
  if (!TYPES.has(type)) throw new Error(`check parse: bad property_type ${type}`)
  const raw = typeof j.doors === 'number' ? j.doors : Number(j.doors)
  const doors = Number.isFinite(raw) && raw >= 1 && raw <= MAX_DOORS ? Math.floor(raw) : null
  return {
    what_it_does: what,
    icp_fit: fit as CheckResult['icp_fit'],
    confidence: conf as CheckResult['confidence'],
    evidence: s('evidence', 500),
    evidence_url: s('evidence_url', 2000) || null,
    property_type: type as PropertyType,
    doors,
    doors_evidence: doors === null ? '' : s('doors_evidence', 500),
  }
}

/**
 * Keep the evidence URL only when Perplexity cited it. Without any citation
 * the verdict is at most low confidence; an evidence URL the model typed
 * without a citation is dropped and a high confidence becomes medium.
 */
export function groundCheck(r: CheckResult, citations: string[]): CheckResult {
  if (!citations.length) return { ...r, evidence_url: null, confidence: 'low' }
  if (r.evidence_url && citations.includes(r.evidence_url)) return r
  return { ...r, evidence_url: null, confidence: r.confidence === 'high' ? 'medium' : r.confidence }
}

export { parsePerplexity }
