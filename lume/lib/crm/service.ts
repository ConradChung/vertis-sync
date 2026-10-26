import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { DEFAULT_STAGES, orderedStages } from '@/lib/crm/stages'
import type { ActivityKind, ActivitySource, CrmActivity, CrmDeal, CrmDealCard, CrmSource, CrmStage } from '@/lib/crm/types'

/**
 * Service-role reads/writes for the CRM tables. Server-only; call after
 * `requireOwner()` / `requireSecret()`. Throws `DbError`.
 */

const DEAL_LIMIT = 2000

function fail(op: string, error: { message: string; code?: string; details?: string; hint?: string } | null): never {
  throw new DbError(op, (error as never) ?? new Error('no data'))
}

/** A campaign's stages, or the defaults when it has none of its own. */
export async function getStages(campaignId: string | null): Promise<CrmStage[]> {
  const sb = createServiceClient()
  const ids = campaignId && campaignId !== 'all' ? [campaignId, '_default'] : ['_default']
  const res = await sb.from('crm_stages').select('campaign_id,name,position,is_terminal').in('campaign_id', ids)
  if (res.error) fail('getStages', res.error)
  const rows = (res.data ?? []) as (CrmStage & { campaign_id: string })[]
  const own = rows.filter((r) => r.campaign_id === campaignId)
  const pick = own.length ? own : rows.filter((r) => r.campaign_id === '_default')
  if (!pick.length) return DEFAULT_STAGES
  return orderedStages(pick.map(({ name, position, is_terminal }) => ({ name, position, is_terminal })))
}

export async function getDeals(campaignId: string | 'all'): Promise<CrmDeal[]> {
  const sb = createServiceClient()
  let q = sb.from('crm_deals').select('*')
  if (campaignId !== 'all') q = q.eq('campaign_id', campaignId)
  const res = await q.order('last_activity_at', { ascending: false, nullsFirst: false }).order('id').limit(DEAL_LIMIT)
  if (res.error) fail('getDeals', res.error)
  return (res.data ?? []) as CrmDeal[]
}

export async function getDeal(id: string): Promise<CrmDeal | null> {
  const sb = createServiceClient()
  const res = await sb.from('crm_deals').select('*').eq('id', id).maybeSingle()
  if (res.error) fail('getDeal', res.error)
  return (res.data as CrmDeal | null) ?? null
}

export async function findDeal(campaignId: string, email: string): Promise<CrmDeal | null> {
  const sb = createServiceClient()
  const res = await sb.from('crm_deals').select('*').eq('campaign_id', campaignId).eq('email', email.toLowerCase()).maybeSingle()
  if (res.error) fail('findDeal', res.error)
  return (res.data as CrmDeal | null) ?? null
}

/** The readable text of a reply payload (Instantly webhook body or adapter shape). */
export function replyText(p: Record<string, Json> | null | undefined): string | null {
  if (!p) return null
  for (const k of ['text', 'reply_text', 'reply_text_snippet', 'body', 'snippet', 'content_preview']) {
    const v = p[k]
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim()
  }
  const ev = p.event
  if (ev && typeof ev === 'object' && !Array.isArray(ev)) return replyText(ev as Record<string, Json>)
  return null
}

export function withSnippets(deals: CrmDeal[], snippets: Record<string, string>): CrmDealCard[] {
  return deals.map((d) => ({ ...d, snippet: snippets[d.id] ?? null }))
}

export async function getFollowupIds(campaignId: string | 'all'): Promise<string[]> {
  const sb = createServiceClient()
  let q = sb.from('lume_crm_followups').select('id')
  if (campaignId !== 'all') q = q.eq('campaign_id', campaignId)
  const res = await q.order('next_action_at').limit(500)
  if (res.error) fail('getFollowupIds', res.error)
  return ((res.data ?? []) as { id: string }[]).map((r) => r.id)
}

export interface ReplyRow {
  deal_id: string
  payload: Record<string, Json> | null
  occurred_at: string
}

export const RECENT_REPLY_LIMIT = 2000

/**
 * Newest reply activities across every deal, in one indexed query
 * (`crm_activities_kind_idx`). Replies are a small fraction of deals, so the
 * board takes snippets and the sparkline from this instead of chunking
 * `.in(deal_id, ...)` lookups over every card.
 */
export async function getRecentReplies(limit = RECENT_REPLY_LIMIT): Promise<ReplyRow[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('crm_activities')
    .select('deal_id,payload,occurred_at')
    .eq('kind', 'replied')
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (res.error) fail('getRecentReplies', res.error)
  return (res.data ?? []) as ReplyRow[]
}

/**
 * Snippets (latest readable reply per deal) and sparkline stamps (replies
 * since `sinceIso`) from newest-first reply rows. `dealIds` limits both to
 * the board's deals; `null` keeps every row (the all-campaigns rail counts
 * every reply).
 */
export function summariseReplies(
  rows: ReplyRow[],
  dealIds: Set<string> | null,
  sinceIso: string
): { snippets: Record<string, string>; stamps: string[] } {
  const snippets: Record<string, string> = {}
  const stamps: string[] = []
  const since = Date.parse(sinceIso)
  for (const r of rows) {
    if (dealIds && !dealIds.has(r.deal_id)) continue
    if (Date.parse(r.occurred_at) >= since) stamps.push(r.occurred_at)
    if (snippets[r.deal_id]) continue
    const t = replyText(r.payload)
    if (t) snippets[r.deal_id] = t
  }
  return { snippets, stamps }
}

export async function getActivities(dealId: string, limit = 200): Promise<CrmActivity[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('crm_activities')
    .select('*')
    .eq('deal_id', dealId)
    .order('occurred_at', { ascending: false })
    .order('id')
    .limit(limit)
  if (res.error) fail('getActivities', res.error)
  return (res.data ?? []) as CrmActivity[]
}

/** Awaiting crm_close_deal actions → { deal_id: action_id }. */
export async function getAwaitingCloses(): Promise<Record<string, string>> {
  const sb = createServiceClient()
  const res = await sb.from('pending_actions').select('id,payload').eq('status', 'awaiting').eq('kind', 'crm_close_deal').limit(500)
  if (res.error) fail('getAwaitingCloses', res.error)
  const out: Record<string, string> = {}
  for (const r of (res.data ?? []) as { id: string; payload: Record<string, Json> }[]) {
    if (typeof r.payload?.deal_id === 'string') out[r.payload.deal_id] = r.id
  }
  return out
}

export async function getLeadRow(leadId: number): Promise<Record<string, Json> | null> {
  const sb = createServiceClient()
  const res = await sb.from('lead_bank').select('*').eq('id', leadId).maybeSingle()
  if (res.error) fail('getLeadRow', res.error)
  return (res.data as Record<string, Json> | null) ?? null
}

export async function findLeadByEmail(
  campaignId: string,
  email: string
): Promise<{ id: number; first_name: string | null; last_name: string | null; company_name: string | null; location: string | null } | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('lead_bank')
    .select('id,first_name,last_name,company_name,location')
    .eq('campaign_id', campaignId)
    .eq('email', email.toLowerCase())
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (res.error) fail('findLeadByEmail', res.error)
  return (res.data as never) ?? null
}

/** Atomic stage change via `crm_set_stage()`. Returns the previous stage, null when the deal is gone. */
export async function setStage(
  dealId: string,
  stage: string,
  source: ActivitySource,
  reason?: string | null,
  payload: Record<string, Json> = {}
): Promise<string | null> {
  const sb = createServiceClient()
  const res = await sb.rpc('crm_set_stage', {
    p_deal_id: dealId,
    p_stage: stage,
    p_source: source,
    p_reason: reason ?? null,
    p_payload: payload,
  })
  if (res.error) fail('setStage', res.error)
  return (res.data as string | null) ?? null
}

export type DealPatch = Partial<Pick<CrmDeal, 'owner' | 'next_action' | 'next_action_at' | 'notes'>>

export async function updateDeal(id: string, patch: DealPatch): Promise<CrmDeal | null> {
  const sb = createServiceClient()
  const row: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() }
  // A new or cleared next action re-arms the follow-up flag.
  if ('next_action_at' in patch) row.followup_flagged_at = null
  const res = await sb.from('crm_deals').update(row).eq('id', id).select('*').maybeSingle()
  if (res.error) fail('updateDeal', res.error)
  return (res.data as CrmDeal | null) ?? null
}

export interface DealUpsert {
  campaign_id: string
  email: string
  source: CrmSource
  lead_id?: number | null
  name?: string | null
  company?: string | null
  city?: string | null
}

/** The deal for (campaign, email), created at Contacted when missing. */
export async function ensureDeal(input: DealUpsert): Promise<CrmDeal> {
  const existing = await findDeal(input.campaign_id, input.email)
  if (existing) return existing
  const sb = createServiceClient()
  const res = await sb
    .from('crm_deals')
    .upsert(
      {
        campaign_id: input.campaign_id,
        email: input.email.toLowerCase(),
        source: input.source,
        lead_id: input.lead_id ?? null,
        name: input.name ?? null,
        company: input.company ?? null,
        city: input.city ?? null,
        stage: 'Contacted',
      },
      { onConflict: 'campaign_id,email', ignoreDuplicates: true }
    )
    .select('*')
    .maybeSingle()
  if (res.error) fail('ensureDeal', res.error)
  if (res.data) return res.data as CrmDeal
  // Lost a race with a concurrent insert: read the winner.
  const again = await findDeal(input.campaign_id, input.email)
  if (!again) fail('ensureDeal', new Error('deal vanished') as never)
  return again
}

/**
 * Append an activity. With `dedupe_key` a replay is ignored and the result is
 * `null`. Bumps the deal's `last_activity_at`.
 */
export async function addActivity(input: {
  deal_id: string
  kind: ActivityKind
  source: ActivitySource
  payload?: Record<string, Json>
  occurred_at?: string
  dedupe_key?: string | null
}): Promise<CrmActivity | null> {
  const sb = createServiceClient()
  const row = {
    deal_id: input.deal_id,
    kind: input.kind,
    source: input.source,
    payload: input.payload ?? {},
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    dedupe_key: input.dedupe_key ?? null,
  }
  const res = row.dedupe_key
    ? await sb.from('crm_activities').upsert(row, { onConflict: 'dedupe_key', ignoreDuplicates: true }).select('*').maybeSingle()
    : await sb.from('crm_activities').insert(row).select('*').single()
  if (res.error) fail('addActivity', res.error)
  if (!res.data) return null
  const bump = await sb
    .from('crm_deals')
    .update({ last_activity_at: row.occurred_at, updated_at: new Date().toISOString() })
    .eq('id', input.deal_id)
    .or(`last_activity_at.is.null,last_activity_at.lt.${row.occurred_at}`)
  if (bump.error) fail('addActivity.bump', bump.error)
  return res.data as CrmActivity
}

/** ⌘K: deals whose email, name or company matches. */
export async function searchDeals(q: string, limit = 8): Promise<Pick<CrmDeal, 'id' | 'campaign_id' | 'email' | 'name' | 'company' | 'stage'>[]> {
  const term = q.replace(/[%_,()*\\]/g, ' ').trim()
  if (!term) return []
  const sb = createServiceClient()
  const like = `%${term}%`
  const res = await sb
    .from('crm_deals')
    .select('id,campaign_id,email,name,company,stage')
    .or(`email.ilike.${like},name.ilike.${like},company.ilike.${like}`)
    .order('last_activity_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (res.error) fail('searchDeals', res.error)
  return (res.data ?? []) as never
}
