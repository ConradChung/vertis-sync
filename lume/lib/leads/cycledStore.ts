import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { summarizeArchived, type ArchivedRow, type ArchivedSummary } from '@/lib/leads/history'

/**
 * `lume_cycled_leads` (a snapshot of every lead `remove_leads` deleted from
 * Instantly) and the `lead_bank` bookkeeping for those leads. Service role
 * only; the owner can read the snapshots (RLS).
 */

export interface CycledLeadInsert {
  campaign_id: string
  instantly_lead_id: string
  /** Lowercased, ≤ 320 chars (null otherwise; the snapshot still has it). */
  email: string | null
  /**
   * The FULL raw Instantly lead object as `POST /leads/list` returned it just
   * before deletion (status, timestamps, counts, interest, payload / custom
   * variables, personalization…), so a removed lead can be inspected or
   * re-uploaded later. Not a Lume-shaped subset.
   */
  snapshot: Record<string, Json>
  reason: string | null
  action_id: string | null
}

const CHUNK = 100

/** Insert snapshots; a retry of the same action never duplicates them (unique action_id + lead). */
export async function insertCycledLeads(rows: CycledLeadInsert[]): Promise<void> {
  if (!rows.length) return
  const sb = createServiceClient()
  const res = await sb.from('lume_cycled_leads').upsert(rows, { onConflict: 'action_id,instantly_lead_id', ignoreDuplicates: true })
  if (res.error) throw new DbError('insertCycledLeads', res.error)
}

/** Drop snapshots of leads that were never deleted (gone already, or not attempted before the run stopped). */
export async function deleteCycledLeads(actionId: string, leadIds: string[]): Promise<void> {
  if (!leadIds.length) return
  const sb = createServiceClient()
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const res = await sb.from('lume_cycled_leads').delete().eq('action_id', actionId).in('instantly_lead_id', leadIds.slice(i, i + CHUNK))
    if (res.error) throw new DbError('deleteCycledLeads', res.error)
  }
}

/** Instantly lead status → the lead_bank archive state the rotator uses for deleted leads. */
export function archiveState(status: number | null): 'completed' | 'bounced' | 'unsubscribed' | 'skipped' {
  if (status === 3) return 'completed'
  if (status === -1) return 'bounced'
  if (status === -2) return 'unsubscribed'
  return 'skipped'
}

/**
 * lead_bank rows still `active` for these (campaign, email) pairs are archived
 * like the rotator archives a deleted lead (state by Instantly status,
 * final_status, finished_at). Rows of other states are left alone. Returns
 * how many rows changed.
 */
export async function archiveLeadBankRows(campaignId: string, leads: { email: string; status: number | null }[], nowIso: string): Promise<number> {
  const sb = createServiceClient()
  const groups = new Map<string, { state: string; status: number | null; emails: string[] }>()
  for (const l of leads) {
    const state = archiveState(l.status)
    const key = `${state}:${l.status}`
    const g = groups.get(key) ?? { state, status: l.status, emails: [] }
    g.emails.push(l.email.toLowerCase())
    groups.set(key, g)
  }
  let changed = 0
  for (const g of groups.values()) {
    for (let i = 0; i < g.emails.length; i += CHUNK) {
      const res = await sb
        .from('lead_bank')
        .update({ state: g.state, final_status: g.status, finished_at: nowIso, updated_at: nowIso })
        .eq('campaign_id', campaignId)
        .eq('state', 'active')
        .in('email', g.emails.slice(i, i + CHUNK))
        .select('id')
      if (res.error) throw new DbError('archiveLeadBankRows', res.error)
      changed += (res.data ?? []).length
    }
  }
  return changed
}

/** lead_bank rows queued for a campaign (assigned, not yet pushed to Instantly). */
export async function countQueuedForCampaign(campaignId: string): Promise<number> {
  const sb = createServiceClient()
  const res = await sb.from('lead_bank').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('state', 'queued')
  if (res.error) throw new DbError('countQueuedForCampaign', res.error)
  return res.count ?? 0
}

const PAGE = 1000
const MAX_HISTORY_ROWS = 20_000

/**
 * The campaign's lead_bank rows that left Instantly (any state but queued /
 * active), summarised, plus how many leads remove_leads snapshotted. Read-only.
 */
export async function archivedLeadHistory(campaignId: string): Promise<ArchivedSummary & { removed_by_lume: number }> {
  const sb = createServiceClient()
  const rows: ArchivedRow[] = []
  for (let from = 0; from < MAX_HISTORY_ROWS; from += PAGE) {
    const res = await sb
      .from('lead_bank')
      .select('state,final_status,email_reply_count')
      .eq('campaign_id', campaignId)
      .not('state', 'in', '(queued,active)')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (res.error) throw new DbError('archivedLeadHistory', res.error)
    const page = (res.data ?? []) as ArchivedRow[]
    rows.push(...page)
    if (page.length < PAGE) break
  }
  const cycled = await sb.from('lume_cycled_leads').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId)
  if (cycled.error) throw new DbError('archivedLeadHistory', cycled.error)
  return { ...summarizeArchived(rows), removed_by_lume: cycled.count ?? 0 }
}
