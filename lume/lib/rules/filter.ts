import { z } from 'zod'
import { applyLeadBankFilter, type LeadBankQuery } from '@/lib/db/leadBankQuery'

/**
 * A rotation rule's `filter` (and a filter-based drag assignment): which
 * `lume_lead_bank` rows are candidates for a campaign.
 *
 * Candidates default to `origin='validation_rows'` — validated leads not yet
 * in `lead_bank` anywhere. `lead_bank` rows are already queued for some
 * campaign; they are candidates only when the filter asks for
 * `source: 'lead_bank'` explicitly, so a rule never silently copies another
 * campaign's queue. Rows already queued for the target campaign are always
 * excluded (`unique(campaign_id, email)` would skip them at execution anyway,
 * but the count shown for confirmation must not include them).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .optional()

export const ruleFilterSchema = z
  .strictObject({
    source: z.enum(['validation_rows', 'lead_bank']).optional(),
    icp_status: optText(64),
    city: optText(120),
    since: z.string().regex(ISO_DATE).optional(),
  })
  .transform((f) => {
    const out: RuleFilter = {}
    if (f.source) out.source = f.source
    if (f.icp_status) out.icp_status = f.icp_status
    if (f.city) out.city = f.city
    if (f.since) out.since = f.since
    return out
  })

export interface RuleFilter {
  source?: 'validation_rows' | 'lead_bank'
  icp_status?: string
  city?: string
  since?: string
}

/** A stored filter → a clean `RuleFilter`; anything that no longer parses is `{}`. */
export function parseRuleFilter(raw: unknown): RuleFilter {
  const r = ruleFilterSchema.safeParse(raw ?? {})
  return r.success ? r.data : {}
}

/** The builder slice `applyFilter` needs (PostgREST's filter builder satisfies it). */
export interface RuleFilterQuery<Q> extends LeadBankQuery<Q> {
  or(filters: string): Q
}

/**
 * Builds the PostgREST query over `lume_lead_bank` for `filter`. With
 * `campaignId`, rows already queued for that campaign are excluded. The id is
 * double-quoted so PostgREST's `or()` grammar treats it as one literal.
 */
export function applyFilter<Q extends RuleFilterQuery<Q>>(query: Q, filter: RuleFilter, opts: { campaignId?: string } = {}): Q {
  let q = applyLeadBankFilter(query, {
    origin: filter.source ?? 'validation_rows',
    icp_status: filter.icp_status,
    city: filter.city,
    since: filter.since,
  })
  if (opts.campaignId) {
    const id = opts.campaignId.replace(/["\\]/g, '')
    q = q.or(`campaign_id.is.null,campaign_id.neq."${id}"`)
  }
  return q
}

export function summarizeFilter(f: RuleFilter): string {
  const parts = [f.source === 'lead_bank' ? 'leads queued elsewhere in lead_bank' : 'unassigned validated leads']
  if (f.icp_status) parts.push(`ICP ${f.icp_status}`)
  if (f.city) parts.push(`city ~ ${f.city}`)
  if (f.since) parts.push(`since ${f.since}`)
  return parts.join(' · ')
}
