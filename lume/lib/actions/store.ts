import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json, PendingActionRow } from '@/lib/db/types'

/**
 * The `pending_actions` state machine, as conditional PATCHes. Each transition
 * names the state it leaves in its filter, so two callers racing for the same
 * row (a Telegram tap and a Lume click, or two execute POSTs) get exactly one
 * winner and everyone else an empty result.
 *
 *   awaiting --decide--> approved | rejected      (claim_status awaiting → claimed)
 *   approved --execute-> executing                (executed_at is null)
 *   executing --finish-> executed | failed        (executed_at set)
 *
 * Kept out of lib/db/service.ts so the parallel Lume tasks merge cleanly.
 */

export async function getAction(id: string): Promise<PendingActionRow | null> {
  const sb = createServiceClient()
  const res = await sb.from('pending_actions').select('*').eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getAction', res.error)
  return (res.data as PendingActionRow | null) ?? null
}

/** Same claim telegram-inbox's lume_ok/lume_no runs, with decided_via='lume'. */
export async function claimDecision(id: string, approve: boolean): Promise<PendingActionRow | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .update({
      claim_status: 'claimed',
      status: approve ? 'approved' : 'rejected',
      decided_via: 'lume',
      decided_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('claim_status', 'awaiting')
    .eq('status', 'awaiting')
    .select()
  if (res.error) throw new DbError('claimDecision', res.error)
  return ((res.data ?? []) as PendingActionRow[])[0] ?? null
}

/** approved + claimed + never executed → executing. Null when someone else got it. */
export async function claimExecution(id: string): Promise<PendingActionRow | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .update({ status: 'executing' })
    .eq('id', id)
    .eq('status', 'approved')
    .eq('claim_status', 'claimed')
    .is('executed_at', null)
    .select()
  if (res.error) throw new DbError('claimExecution', res.error)
  return ((res.data ?? []) as PendingActionRow[])[0] ?? null
}

export async function finishAction(
  id: string,
  status: 'executed' | 'failed',
  result: Record<string, Json>,
  error: string | null
): Promise<void> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .update({ status, result, error, executed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'executing')
  if (res.error) throw new DbError('finishAction', res.error)
}

/** Approved rows nobody executed: the Telegram path's waitUntil was cut. */
export async function getStaleApprovedIds(olderThan: Date, limit = 20): Promise<string[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .select('id')
    .eq('status', 'approved')
    .is('executed_at', null)
    .lt('decided_at', olderThan.toISOString())
    .order('decided_at', { ascending: true })
    .limit(limit)
  if (res.error) throw new DbError('getStaleApprovedIds', res.error)
  return ((res.data ?? []) as { id: string }[]).map((r) => r.id)
}

export interface LeadBankInsert {
  campaign_id: string
  email: string
  first_name?: string | null
  last_name?: string | null
  company_name?: string | null
  website?: string | null
  location?: string | null
  personalization?: string | null
  company_domain?: string | null
  timezone?: string | null
}

/** `on conflict (campaign_id, email) do nothing`; returns how many were new. */
export async function insertQueuedLeads(rows: LeadBankInsert[]): Promise<number> {
  if (!rows.length) return 0
  const sb = createServiceClient()
  const res = await sb
    .from('lead_bank')
    .upsert(
      rows.map((r) => ({ ...r, state: 'queued' })),
      { onConflict: 'campaign_id,email', ignoreDuplicates: true }
    )
    .select('id')
  if (res.error) throw new DbError('insertQueuedLeads', res.error)
  return (res.data ?? []).length
}

export async function getRule(id: string): Promise<{ id: string; name: string; cron: string; active: boolean } | null> {
  const sb = createServiceClient()
  const res = await sb.from('rotation_rules').select('id,name,cron,active').eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getRule', res.error)
  return (res.data as never) ?? null
}

export async function activateRule(id: string, nextRunAt: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb.from('rotation_rules').update({ active: true, next_run_at: nextRunAt }).eq('id', id).select('id')
  if (res.error) throw new DbError('activateRule', res.error)
  return (res.data ?? []).length > 0
}

export async function deleteRule(id: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb.from('rotation_rules').delete().eq('id', id).select('id')
  if (res.error) throw new DbError('deleteRule', res.error)
  return (res.data ?? []).length > 0
}
