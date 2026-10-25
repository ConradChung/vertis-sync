import 'server-only'
import { z } from 'zod'
import {
  countCandidates,
  getCampaignByExternalId,
  getRule,
  resolveLeadRefs,
  type LeadRef,
} from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { UUID_RE } from '@/lib/http/json'
import { ruleFilterSchema, summarizeFilter } from '@/lib/rules/filter'
import { isValidRuleCron, nextRun } from '@/lib/rules/nextRun'
import { CAMPAIGN_ID_RE } from '@/lib/rules/schema'
import { OWNER_TZ } from '@/lib/time/owner'

/**
 * Rotate's two pending-action kinds, built server-side into the snapshot the
 * owner confirms (never trusted from the client):
 *
 * assign_leads — a drop on a campaign card. Either explicit leads
 *   `{ campaign_id, leads: [{origin, id}, …] }` (≤ 500, re-resolved against
 *   lume_lead_bank; ones already queued for the campaign are dropped) or a
 *   filter `{ campaign_id, filter }` ("all N matching"). Payload:
 *   `{ campaign_id, campaign_name, leads | filter, count, summary }`. On
 *   confirm the executor inserts lead_bank rows `state='queued'` with
 *   `on conflict (campaign_id, email) do nothing`.
 *
 * activate_rule — `{ rule_id }`. The rule must exist, be inactive, and have a
 *   valid cron. Payload: `{ rule_id, rule_name, campaign_id, cron, tz,
 *   first_run, summary }`; `meta.ruleId` makes it one-awaiting-per-rule.
 */

export const MAX_LEAD_REFS = 500

const leadRef = z.object({
  origin: z.enum(['lead_bank', 'validation_rows']),
  id: z.string().regex(/^[0-9a-zA-Z-]{1,64}$/),
})

export const assignLeadsPayload = z.union([
  z.strictObject({
    campaign_id: z.string().regex(CAMPAIGN_ID_RE),
    leads: z.array(leadRef).min(1).max(MAX_LEAD_REFS),
  }),
  z.strictObject({
    campaign_id: z.string().regex(CAMPAIGN_ID_RE),
    filter: ruleFilterSchema,
  }),
])

export const activateRulePayload = z.strictObject({ rule_id: z.string().regex(UUID_RE) })

export const rotateActionBody = z.union([
  z.object({ kind: z.literal('assign_leads'), payload: assignLeadsPayload }),
  z.object({ kind: z.literal('activate_rule'), payload: activateRulePayload }),
])

export type RotateBuild =
  | { ok: true; payload: Record<string, Json> & { summary: string }; ruleId?: string }
  | { ok: false; status: number; error: string }

const fmt = new Intl.NumberFormat('en-US')

export async function buildAssignLeads(p: z.infer<typeof assignLeadsPayload>): Promise<RotateBuild> {
  const campaign = await getCampaignByExternalId(p.campaign_id)
  if (!campaign) return { ok: false, status: 404, error: 'campaign_not_found' }
  const name = campaign.name

  if ('leads' in p) {
    const leads: LeadRef[] = await resolveLeadRefs(p.leads, p.campaign_id)
    if (!leads.length) return { ok: false, status: 409, error: 'nothing_to_assign' }
    const dropped = p.leads.length - leads.length
    return {
      ok: true,
      payload: {
        campaign_id: p.campaign_id,
        campaign_name: name,
        leads: leads.map((l) => ({ origin: l.origin, id: l.id })),
        count: leads.length,
        summary:
          `Assign ${fmt.format(leads.length)} selected lead${leads.length === 1 ? '' : 's'} → ${name}` +
          (dropped ? ` (${fmt.format(dropped)} skipped: gone or already queued there)` : ''),
      },
    }
  }

  const count = await countCandidates(p.filter, p.campaign_id)
  if (!count) return { ok: false, status: 409, error: 'nothing_to_assign' }
  return {
    ok: true,
    payload: {
      campaign_id: p.campaign_id,
      campaign_name: name,
      filter: p.filter as Record<string, Json>,
      count,
      summary: `Assign ${fmt.format(count)} leads → ${name} (${summarizeFilter(p.filter)})`,
    },
  }
}

export async function buildActivateRule(p: z.infer<typeof activateRulePayload>): Promise<RotateBuild> {
  const ruleId = p.rule_id.toLowerCase()
  const rule = await getRule(ruleId)
  if (!rule) return { ok: false, status: 404, error: 'rule_not_found' }
  if (rule.active) return { ok: false, status: 409, error: 'already_active' }
  if (!isValidRuleCron(rule.cron)) return { ok: false, status: 409, error: 'invalid_cron' }
  const campaign = await getCampaignByExternalId(rule.campaign_id).catch(() => null)
  const firstRun = nextRun(rule.cron)
  return {
    ok: true,
    ruleId,
    payload: {
      rule_id: ruleId,
      rule_name: rule.name,
      campaign_id: rule.campaign_id,
      cron: rule.cron,
      tz: OWNER_TZ,
      first_run: firstRun,
      summary:
        `Activate rule "${rule.name}" → ${campaign?.name ?? rule.campaign_id}: ${rule.cron} (${OWNER_TZ}), ` +
        `up to ${fmt.format(rule.daily_cap)} ${rule.order_by} leads per run. Each run still asks before assigning.`,
    },
  }
}
