import type { Json } from '@/lib/db/types'

/**
 * Company check (pure): the price quoted before the owner approves a
 * `company_check` — one web-research call per distinct company (deduped by
 * domain) in a validation job's valid leads, telling what the company really
 * does and whether it fits the ICP. The check itself runs in the
 * `company-check` edge function after approval.
 *
 * Unit price, every term from code (mirrors
 * supabase/functions/_shared/company_check/check.ts; tests/companyCheck/
 * model.test.ts imports the edge module and checks they are equal):
 *   Perplexity Sonar  $0.006 per call (PPLX_CALL_USD,
 *                     supabase/functions/_shared/influencer/cost.ts; the
 *                     verify request: sonar, low search context, max 600 tokens)
 *   Haiku parse       ceiling $0.0009401: (983 system + 358 schema + 5,000
 *                     user chars + 500 wrapper allowance) input tokens x
 *                     $0.10/M + 512 max output tokens x $0.50/M (HAIKU_IN_PER_M
 *                     / HAIKU_OUT_PER_M in cost.ts)
 *   => $0.00695 per company (rounded up to $0.00001). The run tallies real
 *   costs (Perplexity usage.cost, Haiku usage tokens) against it.
 */

export const PPLX_CALL_USD = 0.006
export const HAIKU_CEILING_USD = 0.0009401
export const CHECK_USD_PER_COMPANY = 0.00695
/** One approval adds at most this much to a run's cap (the edge function refuses more). */
export const CHECK_APPROVAL_LIMIT_USD = 50
/** operating-city-enricher's DEFAULT_ICP_DESCRIPTION: the ICP when the job has none and the owner names none. */
export const DEFAULT_ICP = 'a property management company that actively manages properties'

export const PRICING_SOURCES = [
  { item: 'Perplexity Sonar call', usd: PPLX_CALL_USD, source: 'PPLX_CALL_USD in supabase/functions/_shared/influencer/cost.ts (request: perplexityRequest in _shared/influencer/verify.ts)' },
  {
    item: 'Haiku parse (ceiling)',
    usd: HAIKU_CEILING_USD,
    source: 'haikuCeilingUsd() in supabase/functions/_shared/company_check/check.ts: input chars capped at 5,000 + system + schema + 500 wrapper tokens at $0.10/M, 512 max output tokens at $0.50/M (HAIKU_IN_PER_M / HAIKU_OUT_PER_M in cost.ts)',
  },
] as const

const cents = (n: number) => Math.round(n * 100) / 100
const ceilCents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100

export interface CheckEstimate {
  companies_to_check: number
  unit_usd: number
  usd: number
  per_lead_usd: number | null
  default_cap_usd: number
  over_one_approval: boolean
}

/** companies x the unit price; per lead over the job's valid leads; a default cap with 10 % headroom (at most one approval's $50). */
export function estimateCheck(companies: number, validLeads: number): CheckEstimate {
  const n = Math.max(0, Math.floor(companies))
  const raw = n * CHECK_USD_PER_COMPANY
  return {
    companies_to_check: n,
    unit_usd: CHECK_USD_PER_COMPANY,
    usd: cents(raw),
    per_lead_usd: validLeads > 0 ? Math.round((raw / validLeads) * 100_000) / 100_000 : null,
    default_cap_usd: Math.min(CHECK_APPROVAL_LIMIT_USD, Math.max(0.1, ceilCents(raw * 1.1))),
    over_one_approval: raw * 1.1 > CHECK_APPROVAL_LIMIT_USD,
  }
}

/** What `company_check_plan` returns (supabase/migrations/*_lume_company_check.sql). */
export interface CheckPlan {
  icp_key: string
  columns: { company: string | null; website: string | null; email: string | null }
  valid_leads: number
  leads_without_company: number
  companies: number
  companies_by_domain: number
  companies_by_name_only: number
  cached: number
  enrichment_icp_status: Record<string, number>
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** null when the snapshot carries what the executor, the edge function and the card read. */
export function companyCheckPayloadError(p: Record<string, Json>): string | null {
  if (typeof p.job_id !== 'string' || !LOWER_UUID.test(p.job_id)) return 'payload.job_id must be a lowercase uuid'
  if (typeof p.icp !== 'string' || !p.icp.trim() || p.icp.length > 1000) return 'payload.icp is required (at most 1000 characters)'
  if (typeof p.companies !== 'number' || !Number.isInteger(p.companies) || p.companies < 1) return 'payload.companies must be a positive integer'
  if (typeof p.max_usd !== 'number' || !(p.max_usd > 0) || p.max_usd > CHECK_APPROVAL_LIMIT_USD) return 'payload.max_usd must be in (0, 50]'
  return null
}
