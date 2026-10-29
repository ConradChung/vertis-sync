import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { PostgrestError } from '@supabase/supabase-js'
import { DbError } from '@/lib/db/service'
import type { Json, PendingActionRow } from '@/lib/db/types'
import { applyFilter, type RuleFilter, type RuleFilterQuery } from '@/lib/rules/filter'
import { maskOperatorKeys } from '@/lib/operators/mask'

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

/** Many rows' status in one `in` query (a reloaded chat's approval cards). Missing ids are absent. */
export async function getActionStatuses(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (!unique.length) return new Map()
  const sb = createServiceClient()
  const res = await sb.from('pending_actions').select('id,status').in('id', unique)
  if (res.error) throw new DbError('getActionStatuses', res.error)
  return new Map(((res.data ?? []) as Pick<PendingActionRow, 'id' | 'status'>[]).map((r) => [r.id, r.status]))
}

/**
 * Same claim telegram-inbox's lume_ok/lume_no runs, with decided_via='lume'
 * (the owner's tap), 'agent' (skip-permissions mode approving for them) or
 * 'operator' (a Grok Bot signed in with its operator key; `operatorId` is
 * stored as `decided_by_operator`) or 'grant' (a campaign in Auto reply mode,
 * lib/actions/grant.ts). `payload` (an approver's Edit of a
 * send_reply, already validated) is written in the same conditional PATCH,
 * so the edit lands only if this claim wins.
 */
export async function claimDecision(
  id: string,
  approve: boolean,
  via: 'lume' | 'agent' | 'operator' | 'grant' = 'lume',
  operatorId?: string | null,
  payload?: Record<string, Json>
): Promise<PendingActionRow | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .update({
      claim_status: 'claimed',
      status: approve ? 'approved' : 'rejected',
      decided_via: via,
      decided_at: new Date().toISOString(),
      ...(operatorId ? { decided_by_operator: operatorId } : {}),
      ...(payload ? { payload } : {}),
    })
    .eq('id', id)
    .eq('claim_status', 'awaiting')
    .eq('status', 'awaiting')
    .select()
  if (res.error) throw new DbError('claimDecision', res.error)
  return ((res.data ?? []) as PendingActionRow[])[0] ?? null
}

/**
 * A Grok Bot's Edit of an awaiting send_reply: replace the payload while the
 * row is still awaiting and unclaimed (a decision in between wins, null).
 */
export async function saveAwaitingPayload(id: string, payload: Record<string, Json>): Promise<PendingActionRow | null> {
  const res = await createServiceClient()
    .from('pending_actions')
    .update({ payload })
    .eq('id', id)
    .eq('status', 'awaiting')
    .eq('claim_status', 'awaiting')
    .select()
  if (res.error) throw new DbError('saveAwaitingPayload', res.error)
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
    // An operator sign-in link is never stored in plaintext (lib/operators/mask.ts).
    .update({ status, result: maskOperatorKeys(result), error: error === null ? null : maskOperatorKeys(error), executed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'executing')
  if (res.error) throw new DbError('finishAction', res.error)
}

/**
 * send_reply only: record that the Instantly send is about to be attempted.
 * Set right before /emails/reply; from then on the row blocks a new reply to
 * the same inbound email even if it fails or is interrupted
 * (pending_actions_one_reply_per_inbound_idx). Throws when the row is not
 * this run's executing row, so the caller does not send.
 */
export async function markSendAttempted(id: string): Promise<void> {
  const res = await createServiceClient()
    .from('pending_actions')
    .update({ send_attempted: true })
    .eq('id', id)
    .eq('status', 'executing')
    .select('id')
  if (res.error) throw new DbError('markSendAttempted', res.error)
  if (!(res.data ?? []).length) throw new Error('markSendAttempted: the row is not executing')
}

/**
 * Awaiting send_reply rows for one reply (`reply_to_uuid`) or one lead
 * (campaign + lead_email): what a closing label must deny. Two indexed reads,
 * merged by id.
 */
export async function listAwaitingReplyActions(campaignId: string, leadEmail: string, replyToUuid?: string | null): Promise<Pick<PendingActionRow, 'id'>[]> {
  const sb = createServiceClient()
  const base = () => sb.from('pending_actions').select('id').eq('kind', 'send_reply').eq('status', 'awaiting')
  const [byLead, byReply] = await Promise.all([
    base().eq('payload->>campaign_id', campaignId).eq('payload->>lead_email', leadEmail.toLowerCase()).limit(50),
    replyToUuid ? base().eq('payload->>reply_to_uuid', replyToUuid).limit(50) : Promise.resolve({ data: [], error: null }),
  ])
  if (byLead.error) throw new DbError('listAwaitingReplyActions', byLead.error)
  if (byReply.error) throw new DbError('listAwaitingReplyActions', byReply.error as PostgrestError)
  const ids = new Set([...(byLead.data ?? []), ...(byReply.data ?? [])].map((r) => (r as { id: string }).id))
  return [...ids].map((id) => ({ id }))
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

/**
 * `executing` rows that never finished (the function running them was killed
 * mid-handler) and last changed before `olderThan` → `failed` with
 * `result.error = 'interrupted'`. They are never re-run: the handler may have
 * reached Instantly or the pipeline before it died, and a re-run could do it
 * twice. Returns the rows it failed (one conditional UPDATE, so a late
 * finishAction and this never both win).
 */
export async function failInterruptedActions(olderThan: Date, limit = 20): Promise<PendingActionRow[]> {
  const sb = createServiceClient()
  const stale = await sb
    .from('pending_actions')
    .select('id')
    .eq('status', 'executing')
    .is('executed_at', null)
    .lt('updated_at', olderThan.toISOString())
    .order('updated_at', { ascending: true })
    .limit(limit)
  if (stale.error) throw new DbError('failInterruptedActions', stale.error)
  const ids = ((stale.data ?? []) as { id: string }[]).map((r) => r.id)
  if (!ids.length) return []
  const res = await sb
    .from('pending_actions')
    .update({
      status: 'failed',
      error: 'interrupted',
      result: { error: 'interrupted' },
      executed_at: new Date().toISOString(),
    })
    .in('id', ids)
    .eq('status', 'executing')
    .is('executed_at', null)
    .select()
  if (res.error) throw new DbError('failInterruptedActions', res.error)
  return (res.data ?? []) as PendingActionRow[]
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

/** A `lume_lead_bank` reference, as Rotate's drag-drop sends it. */
export interface LeadBankRef {
  origin: 'lead_bank' | 'validation_rows'
  id: string
}

interface LeadBankViewRow {
  origin: string
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
  city: string | null
  campaign_id: string | null
}

const VIEW_COLS = 'origin,id,email,first_name,last_name,company_name,city,campaign_id'
/** PostgREST's default max-rows; filter reads page at this size. */
const PAGE = 1000
/** Ids per `.in()` lookup: 100 uuids keep the GET URL well under proxy limits. */
export const IN_CHUNK = 100

const toInsert = (campaignId: string) => (r: LeadBankViewRow): LeadBankInsert | null => {
  const email = r.email?.trim().toLowerCase()
  if (!email) return null
  return {
    campaign_id: campaignId,
    email,
    first_name: r.first_name,
    last_name: r.last_name,
    company_name: r.company_name,
    location: r.city,
  }
}

/** One row per email (first wins), so a batch never conflicts with itself. */
function dedupe(rows: (LeadBankInsert | null)[]): LeadBankInsert[] {
  const seen = new Set<string>()
  const out: LeadBankInsert[] = []
  for (const r of rows) {
    if (!r || seen.has(r.email)) continue
    seen.add(r.email)
    out.push(r)
  }
  return out
}

/**
 * The referenced `lume_lead_bank` rows that still exist, minus any already
 * queued for `campaignId`, as lead_bank inserts for it.
 */
export async function resolveLeadsByRefs(refs: LeadBankRef[], campaignId: string): Promise<LeadBankInsert[]> {
  if (!refs.length) return []
  const sb = createServiceClient()
  const wanted = new Set(refs.map((r) => `${r.origin}:${r.id}`))
  const ids = [...new Set(refs.map((r) => r.id))]
  const found: LeadBankViewRow[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const res = await sb.from('lume_lead_bank').select(VIEW_COLS).in('id', ids.slice(i, i + IN_CHUNK))
    if (res.error) throw new DbError('resolveLeadsByRefs', res.error)
    found.push(...((res.data ?? []) as unknown as LeadBankViewRow[]))
  }
  return dedupe(
    found.filter((r) => wanted.has(`${r.origin}:${r.id}`) && r.campaign_id !== campaignId).map(toInsert(campaignId))
  )
}

/**
 * Up to `limit` `lume_lead_bank` candidates for `filter` (the same query the
 * confirmation counted), minus rows already queued for `campaignId`, newest
 * or oldest first, as lead_bank inserts for it.
 */
export async function resolveLeadsByFilter(
  filter: RuleFilter,
  campaignId: string,
  limit: number,
  orderBy: 'newest' | 'oldest' = 'newest'
): Promise<LeadBankInsert[]> {
  if (!(limit > 0)) return []
  const sb = createServiceClient()
  type ListQuery = RuleFilterQuery<ListQuery> & {
    order(column: string, opts: { ascending: boolean; nullsFirst?: boolean }): ListQuery
    range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>
  }
  const rows: LeadBankViewRow[] = []
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1
    const q = sb.from('lume_lead_bank').select(VIEW_COLS) as unknown as ListQuery
    const res = await applyFilter<ListQuery>(q, filter, { campaignId })
      .order('created_at', { ascending: orderBy === 'oldest', nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, to)
    if (res.error) throw new DbError('resolveLeadsByFilter', res.error)
    const page = (res.data ?? []) as LeadBankViewRow[]
    rows.push(...page)
    if (page.length < to - from + 1) break
  }
  return dedupe(rows.map(toInsert(campaignId)))
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

/**
 * Actions decided since `since` (newest decision first, at most `limit`):
 * the /operator page's "Recent outcomes" and the Overview vertical strip.
 */
export async function listDecidedSince(
  since: Date,
  limit = 200,
  opts: { via?: NonNullable<PendingActionRow['decided_via']> } = {}
): Promise<PendingActionRow[]> {
  const sb = createServiceClient()
  let q = sb.from('pending_actions').select('*').neq('status', 'awaiting').gte('decided_at', since.toISOString())
  if (opts.via) q = q.eq('decided_via', opts.via)
  const res = await q.order('decided_at', { ascending: false }).limit(limit)
  if (res.error) throw new DbError('listDecidedSince', res.error)
  return (res.data ?? []) as PendingActionRow[]
}
