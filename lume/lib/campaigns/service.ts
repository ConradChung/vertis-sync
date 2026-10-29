import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { PendingActionKind, PendingActionRow, RotationRuleRow } from '@/lib/db/types'
import type { CampaignJob, LeadSources } from '@/lib/campaigns/types'

/**
 * Campaigns screen queries (Task 13). Kept apart from `lib/db/service.ts`
 * so parallel tasks do not collide there. Service role: callers must have
 * passed `requireOwner()` first.
 */

/**
 * An action of `kind` whose `payload->>field` equals `value`, in one of
 * `statuses` (default: awaiting only). Newest first.
 */
export async function findAwaitingActionBy(
  kind: PendingActionKind,
  field: string,
  value: string,
  statuses: readonly PendingActionRow['status'][] = ['awaiting']
): Promise<PendingActionRow | null> {
  if (!/^[a-z_]+$/.test(field)) throw new Error(`bad payload field: ${field}`)
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .select('*')
    .in('status', [...statuses])
    .eq('kind', kind)
    .eq(`payload->>${field}`, value)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (res.error) throw new DbError('findAwaitingActionBy', res.error)
  return (res.data as PendingActionRow | null) ?? null
}

const JOB_COLS = 'id,filename,status,instantly_status,total_rows,valid_count,enrich,enriched_rows,instantly_pushed,created_at'

/** Validation jobs pushed (or headed) to this Instantly campaign, newest first. */
export async function getCampaignJobs(campaignId: string): Promise<CampaignJob[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('validation_jobs')
    .select(JOB_COLS)
    .eq('instantly_campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(200)
  if (res.error) throw new DbError('getCampaignJobs', res.error)
  return (res.data ?? []) as CampaignJob[]
}

/** Newest `events.created_at` per campaign id (over the newest 2,000 matching events). */
export async function getLastActivity(campaignIds: string[]): Promise<Record<string, string>> {
  const ids = campaignIds.filter(Boolean)
  if (!ids.length) return {}
  const sb = createServiceClient()
  const res = await sb
    .from('events')
    .select('campaign_id,created_at')
    .in('campaign_id', ids)
    .order('created_at', { ascending: false })
    .limit(2000)
  if (res.error) throw new DbError('getLastActivity', res.error)
  const out: Record<string, string> = {}
  for (const r of (res.data ?? []) as { campaign_id: string; created_at: string }[]) {
    if (!out[r.campaign_id]) out[r.campaign_id] = r.created_at
  }
  return out
}

/** Lead bank counts by state, the rotation_runs log and the instantly-rotate schedules (`lume_campaign_lead_sources`). */
export async function getLeadSources(campaignId: string): Promise<LeadSources> {
  const sb = createServiceClient()
  const res = await sb.rpc('lume_campaign_lead_sources', { p_campaign: campaignId })
  if (res.error) throw new DbError('getLeadSources', res.error)
  const d = (res.data ?? {}) as Partial<LeadSources>
  return { bank: d.bank ?? {}, runs: d.runs ?? null, crons: d.crons ?? [] }
}

/** Rotation rules that feed this campaign. */
export async function getCampaignRules(campaignId: string): Promise<RotationRuleRow[]> {
  const sb = createServiceClient()
  const res = await sb.from('rotation_rules').select('*').eq('campaign_id', campaignId).order('created_at', { ascending: true })
  if (res.error) throw new DbError('getCampaignRules', res.error)
  return (res.data ?? []) as RotationRuleRow[]
}
