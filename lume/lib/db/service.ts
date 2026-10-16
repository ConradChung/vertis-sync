import 'server-only'
import type { PostgrestError } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { applyLeadBankFilter, pageRange, type LeadBankFilter, type LeadBankQuery } from '@/lib/db/leadBankQuery'
import type {
  EventInsert,
  EventRow,
  GateKind,
  GateRow,
  LeadBankRow,
  LumeCampaignRow,
  OrderRow,
  Overview,
  ScheduledJob,
} from '@/lib/db/types'

/**
 * Typed reads/writes over the service-role client. Server-only; call after
 * `requireOwner()` / `requireSecret()` has passed. Every function returns
 * data or throws `DbError` — routes map that to a 500 with `dbErrorResponse`.
 *
 * The views and RPCs are service_role-only in the database (see the
 * lume_views migrations); the browser never reads them directly.
 *
 * Every `created_at` order carries a stable tiebreak (`target_id` / `id`) so
 * two rows written in the same transaction keep one order across requests
 * and pages never show a row twice or skip one.
 */

export class DbError extends Error {
  readonly op: string
  readonly code: string | undefined
  readonly details: string | undefined
  readonly hint: string | undefined

  constructor(op: string, error: Pick<PostgrestError, 'message' | 'code' | 'details' | 'hint'> | Error) {
    super(`${op}: ${error.message}`)
    this.name = 'DbError'
    this.op = op
    if ('code' in error) {
      this.code = error.code
      this.details = error.details ?? undefined
      this.hint = error.hint ?? undefined
    }
  }
}

export const isDbError = (e: unknown): e is DbError => e instanceof DbError

/** PostgREST 416: the requested offset lies past the (exact-counted) total. */
const RANGE_NOT_SATISFIABLE = 'PGRST103'

function unwrap<T>(op: string, res: { data: T | null; error: PostgrestError | null }): T {
  if (res.error) throw new DbError(op, res.error)
  if (res.data === null || res.data === undefined) throw new DbError(op, new Error('no data'))
  return res.data
}

// ---------------------------------------------------------------------------
// Gates

export async function getGates(): Promise<GateRow[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('lume_gates')
    .select('*')
    .order('created_at', { ascending: true })
    .order('target_id', { ascending: true })
  return unwrap('getGates', res) as GateRow[]
}

/** `null` when the gate is no longer open (already handled, or never was). */
export async function getGate(kind: GateKind | string, targetId: string): Promise<GateRow | null> {
  const sb = createServiceClient()
  const res = await sb.from('lume_gates').select('*').eq('kind', kind).eq('target_id', targetId).maybeSingle()
  if (res.error) throw new DbError('getGate', res.error)
  return (res.data as GateRow | null) ?? null
}

// ---------------------------------------------------------------------------
// Orders

export async function getOrders({ limit = 100 }: { limit?: number } = {}): Promise<OrderRow[]> {
  const sb = createServiceClient()
  const n = Math.min(Math.max(Math.floor(limit), 1), 500)
  const res = await sb
    .from('lume_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(n)
  return unwrap('getOrders', res) as OrderRow[]
}

// ---------------------------------------------------------------------------
// Lead bank (~3k rows: always paginated)

export interface LeadBankPage {
  rows: LeadBankRow[]
  total: number
  page: number
  pageSize: number
}

export async function getLeadBank({
  filter = {},
  page = 1,
  pageSize = 100,
}: { filter?: LeadBankFilter; page?: number; pageSize?: number } = {}): Promise<LeadBankPage> {
  const sb = createServiceClient()
  const [from, to] = pageRange(page, pageSize)
  // `count: 'exact'` runs a second `count(*)` over the filtered union view on
  // every page. At ~3k rows that is a few ms and the Rotate screen needs the
  // total for its pager; switch to 'estimated' if lead_bank grows past ~100k.
  const base = sb.from('lume_lead_bank').select('*', { count: 'exact' })
  const res = await applyLeadBankFilter(base, filter)
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, to)
  if (res.error) {
    // `.range()` sends `offset`/`limit`; with an exact count PostgREST answers
    // 416 when the offset passes the total. For a pager that is an empty page.
    // (Verified live: offset 1,000,000 → 416 PGRST103.) The error carries no
    // count, so fetch the real total with a head-only count for the pager.
    if (res.error.code === RANGE_NOT_SATISFIABLE) {
      return { rows: [], total: await countLeadBank(filter), page: Math.max(1, Math.floor(page)), pageSize: to - from + 1 }
    }
    throw new DbError('getLeadBank', res.error)
  }
  return {
    rows: (res.data ?? []) as LeadBankRow[],
    total: res.count ?? 0,
    page: Math.max(1, Math.floor(page)),
    pageSize: to - from + 1,
  }
}

/** Head-only exact count of the filtered lead bank (no rows transferred). */
async function countLeadBank(filter: LeadBankFilter): Promise<number> {
  const sb = createServiceClient()
  // Typed as the narrow builder slice: inferring applyLeadBankFilter's generic
  // over the full head-query type trips TS2589 (instantiation too deep).
  type HeadQuery = LeadBankQuery<HeadQuery> &
    PromiseLike<{ count: number | null; error: PostgrestError | null }>
  const q = sb.from('lume_lead_bank').select('id', { count: 'exact', head: true }) as unknown as HeadQuery
  const res = await applyLeadBankFilter<HeadQuery>(q, filter)
  if (res.error) throw new DbError('getLeadBank.count', res.error)
  return res.count ?? 0
}

// ---------------------------------------------------------------------------
// RPCs

export async function getOverview(): Promise<Overview> {
  const sb = createServiceClient()
  const res = await sb.rpc('lume_overview')
  return unwrap('getOverview', res) as Overview
}

/** `lume_scheduled_jobs()` coalesces to `'[]'::json`, so `unwrap` never sees null here. */
export async function getScheduledJobs(): Promise<ScheduledJob[]> {
  const sb = createServiceClient()
  const res = await sb.rpc('lume_scheduled_jobs')
  return unwrap('getScheduledJobs', res) as ScheduledJob[]
}

// ---------------------------------------------------------------------------
// Campaigns

export async function getCampaigns(): Promise<LumeCampaignRow[]> {
  const sb = createServiceClient()
  const res = await sb.from('lume_campaigns').select('*').order('family').order('name').order('id')
  return unwrap('getCampaigns', res) as LumeCampaignRow[]
}

// ---------------------------------------------------------------------------
// Events

export async function getRecentEvents({
  limit = 50,
  types,
}: { limit?: number; types?: string[] } = {}): Promise<EventRow[]> {
  const sb = createServiceClient()
  const n = Math.min(Math.max(Math.floor(limit), 1), 500)
  let q = sb.from('events').select('*')
  if (types && types.length) q = q.in('type', types)
  const res = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(n)
  return unwrap('getRecentEvents', res) as EventRow[]
}

/**
 * Append to the feed. With `webhook_id` set it is an upsert on the unique
 * `events_webhook_id_idx` (non-partial since 20261015071538 — PostgREST emits
 * `on conflict (webhook_id)` with no predicate) that ignores duplicates, so an
 * Instantly retry never double-counts; the result is then `null` for the
 * duplicate.
 */
export async function logEvent(input: EventInsert): Promise<EventRow | null> {
  const sb = createServiceClient()
  const row = {
    type: input.type,
    source: input.source,
    source_id: input.source_id ?? null,
    campaign_id: input.campaign_id ?? null,
    lead_email: input.lead_email ?? null,
    title: input.title,
    payload: input.payload ?? {},
    webhook_id: input.webhook_id ?? null,
  }
  if (row.webhook_id) {
    const res = await sb
      .from('events')
      .upsert(row, { onConflict: 'webhook_id', ignoreDuplicates: true })
      .select()
      .maybeSingle()
    if (res.error) throw new DbError('logEvent', res.error)
    return (res.data as EventRow | null) ?? null
  }
  const res = await sb.from('events').insert(row).select().single()
  return unwrap('logEvent', res) as EventRow
}

/** Slim rows for counting: events of `types` since `sinceIso` (capped at 5,000). */
export async function getEventStamps({
  types,
  sinceIso,
}: {
  types: string[]
  sinceIso: string
}): Promise<Pick<EventRow, 'type' | 'campaign_id' | 'created_at'>[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('events')
    .select('type,campaign_id,created_at')
    .in('type', types)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(5000)
  return unwrap('getEventStamps', res) as Pick<EventRow, 'type' | 'campaign_id' | 'created_at'>[]
}

/** Newest events whose type starts with any of `prefixes` (e.g. `agent.`, `lume.`). */
export async function getEventsByTypePrefix(prefixes: string[], limit = 20): Promise<EventRow[]> {
  const sb = createServiceClient()
  const n = Math.min(Math.max(Math.floor(limit), 1), 200)
  // Prefixes are code constants; `%`/`,` never come from user input here.
  const or = prefixes.map((p) => `type.like.${p}*`).join(',')
  const res = await sb
    .from('events')
    .select('*')
    .or(or)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(n)
  return unwrap('getEventsByTypePrefix', res) as EventRow[]
}
