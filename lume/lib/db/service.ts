import 'server-only'
import type { PostgrestError } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { applyLeadBankFilter, pageRange, type LeadBankFilter, type LeadBankQuery } from '@/lib/db/leadBankQuery'
import type {
  EventInsert,
  EventRow,
  GateKind,
  Json,
  GateRow,
  JobProgress,
  LeadBankRow,
  LumeCampaignRow,
  OrderRow,
  Overview,
  PendingActionKind,
  PendingActionRow,
  ScheduledJob,
} from '@/lib/db/types'
import {
  mergeRowData,
  ROW_STATUSES,
  ROWS_PAGE_SIZE,
  toRowView,
  type RawValidationRow,
  type ValidationRowView,
} from '@/lib/validate/rows'

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

// ---------------------------------------------------------------------------
// Validate: job progress, per-lead rows, Lume-local push settings

const JOB_PROGRESS_COLS =
  'id,filename,status,total_rows,processed_rows,eta_seconds,eta_updated_at,enrich,enrich_started,enriched_rows,' +
  'finder_status,rows_missing_email,emails_found,instantly_status,instantly_campaign_id,instantly_campaign_name,' +
  'location_barrier,company_barrier,company_strict'

/** `null` when the job does not exist. Status counts are head-only exact counts (no rows move). */
export async function getJobProgress(jobId: string): Promise<JobProgress | null> {
  const sb = createServiceClient()
  const jobRes = await sb.from('validation_jobs').select(JOB_PROGRESS_COLS).eq('id', jobId).maybeSingle()
  if (jobRes.error) throw new DbError('getJobProgress', jobRes.error)
  if (!jobRes.data) return null
  const counts = await Promise.all(
    ROW_STATUSES.map(async (status) => {
      const r = await sb.from('validation_rows').select('id', { count: 'exact', head: true }).eq('job_id', jobId).eq('status', status)
      if (r.error) throw new DbError(`getJobProgress.count.${status}`, r.error)
      return [status, r.count ?? 0] as const
    })
  )
  const j = jobRes.data as unknown as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  return {
    id: String(j.id),
    filename: (j.filename as string | null) ?? null,
    status: (j.status as string | null) ?? null,
    total_rows: num(j.total_rows),
    processed_rows: num(j.processed_rows),
    eta_seconds: typeof j.eta_seconds === 'number' ? j.eta_seconds : null,
    eta_updated_at: (j.eta_updated_at as string | null) ?? null,
    enrich: j.enrich === true,
    enrich_started: j.enrich_started === true,
    enriched_rows: num(j.enriched_rows),
    finder_status: (j.finder_status as string | null) ?? null,
    rows_missing_email: typeof j.rows_missing_email === 'number' ? j.rows_missing_email : null,
    emails_found: typeof j.emails_found === 'number' ? j.emails_found : null,
    instantly_status: (j.instantly_status as string | null) ?? null,
    instantly_campaign_id: (j.instantly_campaign_id as string | null) ?? null,
    instantly_campaign_name: (j.instantly_campaign_name as string | null) ?? null,
    // DB defaults: location off, company on, strict off.
    location_barrier: j.location_barrier === true,
    company_barrier: j.company_barrier !== false,
    company_strict: j.company_strict === true,
    counts: Object.fromEntries(counts) as JobProgress['counts'],
  }
}

export interface JobRowsPage {
  rows: ValidationRowView[]
  total: number
  page: number
  pageSize: number
}

/** 100 rows per page, `order=row_index`; `page` is 0-based. */
export async function getJobRows(jobId: string, page: number): Promise<JobRowsPage> {
  const sb = createServiceClient()
  const p = Math.max(0, Math.floor(page))
  const from = p * ROWS_PAGE_SIZE
  const res = await sb
    .from('validation_rows')
    .select('id,row_index,email,status,validation_result,enrichment_status,instantly_status,row_data', { count: 'exact' })
    .eq('job_id', jobId)
    .order('row_index', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + ROWS_PAGE_SIZE - 1)
  if (res.error) {
    if (res.error.code === RANGE_NOT_SATISFIABLE) {
      const c = await sb.from('validation_rows').select('id', { count: 'exact', head: true }).eq('job_id', jobId)
      if (c.error) throw new DbError('getJobRows.count', c.error)
      return { rows: [], total: c.count ?? 0, page: p, pageSize: ROWS_PAGE_SIZE }
    }
    throw new DbError('getJobRows', res.error)
  }
  return {
    rows: ((res.data ?? []) as RawValidationRow[]).map(toRowView),
    total: res.count ?? 0,
    page: p,
    pageSize: ROWS_PAGE_SIZE,
  }
}

export type RowEditResult =
  | { ok: true; row: ValidationRowView; emailChanged: boolean; fields: string[] }
  | { ok: false; reason: 'not_found' | 'not_pending' }

/**
 * Edit a row the validator has not reached yet. Conditional on
 * `status='pending'` at write time, so a row the validator claims between our
 * read and write is refused (409), never overwritten. `row_data` keys are
 * merged, not replaced. A new email is also written to the job's email column
 * inside `row_data` when that column exists there (the CSV export reads it).
 */
export async function updatePendingRow(
  jobId: string,
  rowId: string,
  edit: { email?: string; row_data_patch?: Record<string, string | null> }
): Promise<RowEditResult> {
  const sb = createServiceClient()
  const cur = await sb
    .from('validation_rows')
    .select('id,status,email,row_data')
    .eq('id', rowId)
    .eq('job_id', jobId)
    .maybeSingle()
  if (cur.error) throw new DbError('updatePendingRow.read', cur.error)
  if (!cur.data) return { ok: false, reason: 'not_found' }
  const row = cur.data as { status: string; email: string | null; row_data: Record<string, unknown> | null }
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' }

  const patch: Record<string, string | null> = { ...(edit.row_data_patch ?? {}) }
  const emailChanged = edit.email !== undefined && edit.email !== row.email
  if (emailChanged) {
    const job = await sb.from('validation_jobs').select('email_column').eq('id', jobId).maybeSingle()
    if (job.error) throw new DbError('updatePendingRow.job', job.error)
    const col = (job.data as { email_column?: string | null } | null)?.email_column
    if (col && row.row_data && col in row.row_data) patch[col] = edit.email!
  }
  const update: Record<string, unknown> = { row_data: mergeRowData(row.row_data, patch) }
  if (emailChanged) update.email = edit.email

  const res = await sb
    .from('validation_rows')
    .update(update)
    .eq('id', rowId)
    .eq('job_id', jobId)
    .eq('status', 'pending')
    .select('id,row_index,email,status,validation_result,enrichment_status,instantly_status,row_data')
  if (res.error) throw new DbError('updatePendingRow', res.error)
  const updated = (res.data ?? []) as RawValidationRow[]
  if (updated.length === 0) return { ok: false, reason: 'not_pending' }
  return { ok: true, row: toRowView(updated[0]), emailChanged, fields: Object.keys(edit.row_data_patch ?? {}) }
}

export const CAMPAIGN_CHOICE_STATUSES = ['awaiting_campaign', 'choosing_campaign'] as const
export const PUSH_REVIEW_STATUSES = ['configuring', 'reviewing_company'] as const

/**
 * Campaign pick (what the root app's `/api/instantly/push` writes, minus the
 * push): name + id, clear the Telegram candidates, move to `configuring` —
 * only while the job is still waiting for a campaign. `false` = the gate had
 * already moved on (409).
 */
export async function pickCampaign(jobId: string, campaign: { id: string; name: string }): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb
    .from('validation_jobs')
    .update({
      instantly_campaign_id: campaign.id,
      instantly_campaign_name: campaign.name,
      instantly_campaign_candidates: null,
      instantly_status: 'configuring',
    })
    .eq('id', jobId)
    .in('instantly_status', [...CAMPAIGN_CHOICE_STATUSES])
    .select('id')
  if (res.error) throw new DbError('pickCampaign', res.error)
  return (res.data ?? []).length > 0
}

export interface BarrierPatch {
  location_barrier?: boolean
  company_barrier?: boolean
  company_strict?: boolean
}

/** Barrier / names-mode toggles, only while the push is being configured. `false` → 409. */
export async function setBarriers(jobId: string, patch: BarrierPatch): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb
    .from('validation_jobs')
    .update(patch)
    .eq('id', jobId)
    .in('instantly_status', [...PUSH_REVIEW_STATUSES])
    .select('id')
  if (res.error) throw new DbError('setBarriers', res.error)
  return (res.data ?? []).length > 0
}

// ---------------------------------------------------------------------------
// Pending actions (create side; Task 12 decides/executes)

/** Open (awaiting) action of `kind` for `jobId`, if any. */
export async function findAwaitingAction(kind: PendingActionKind, jobId: string): Promise<PendingActionRow | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .select('*')
    .eq('status', 'awaiting')
    .eq('kind', kind)
    .eq('payload->>job_id', jobId)
    .limit(1)
    .maybeSingle()
  if (res.error) throw new DbError('findAwaitingAction', res.error)
  return (res.data as PendingActionRow | null) ?? null
}

export async function insertPendingAction(row: {
  kind: PendingActionKind
  payload: Record<string, Json>
  requested_by: PendingActionRow['requested_by']
  agent_run_id?: string | null
  rule_id?: string | null
}): Promise<PendingActionRow> {
  const sb = createServiceClient()
  const res = await sb.from('pending_actions').insert(row).select().single()
  return unwrap('insertPendingAction', res) as PendingActionRow
}

export async function setActionMessageId(id: string, messageId: number): Promise<void> {
  const sb = createServiceClient()
  const res = await sb.from('pending_actions').update({ telegram_message_id: messageId }).eq('id', id)
  if (res.error) throw new DbError('setActionMessageId', res.error)
}

/** The job fields a push confirmation is built from. */
export async function getPushJob(jobId: string): Promise<{
  id: string
  filename: string | null
  valid_count: number | null
  instantly_status: string | null
  instantly_campaign_id: string | null
  instantly_campaign_name: string | null
  location_barrier: boolean | null
  company_barrier: boolean | null
  company_strict: boolean | null
} | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('validation_jobs')
    .select('id,filename,valid_count,instantly_status,instantly_campaign_id,instantly_campaign_name,location_barrier,company_barrier,company_strict')
    .eq('id', jobId)
    .maybeSingle()
  if (res.error) throw new DbError('getPushJob', res.error)
  return (res.data as never) ?? null
}
