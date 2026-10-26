import 'server-only'
import type { PostgrestError } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { applyLeadBankFilter, pageRange, type LeadBankFilter, type LeadBankQuery } from '@/lib/db/leadBankQuery'
import { applyFilter, type RuleFilter, type RuleFilterQuery } from '@/lib/rules/filter'
import type { InstantlyCampaignDetail } from '@/lib/adapters/instantly.map'
import { lumeCampaignStatus } from '@/lib/adapters/instantly.map'
import type {
  EventInsert,
  EventRow,
  GateKind,
  Json,
  GateRow,
  ApolloOrderRow,
  JobBatchRow,
  JobProgress,
  JobSampleSource,
  LeadBankRow,
  LumeCampaignRow,
  OrderRow,
  Overview,
  PendingActionKind,
  PendingActionRow,
  RotationRuleRow,
  ScheduledJob,
  TelegramIngestInsert,
  TelegramIngestRow,
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

/**
 * Rows may be edited only while the job is parked on the owner at the finder
 * prompt (`finder_status='awaiting_decision'`): the validator has not been
 * invoked yet. Once it runs it reads pending rows in batches and writes
 * verdicts by id, so an edit then could pair a new email with the old
 * email's verdict. (email-validator itself is deliberately untouched.)
 */
export const ROW_EDIT_FINDER_STATUS = 'awaiting_decision'
export const ROW_EDIT_BLOCKED_REASON =
  'Rows can be edited only while the job waits at the email-finder prompt, before the validator starts.'

interface JobEditInfo {
  finder_status: string | null
  email_column: string | null
  column_order: unknown
}

async function getJobEditInfo(jobId: string): Promise<JobEditInfo | null> {
  const sb = createServiceClient()
  const res = await sb.from('validation_jobs').select('finder_status,email_column,column_order').eq('id', jobId).maybeSingle()
  if (res.error) throw new DbError('getJobEditInfo', res.error)
  return (res.data as JobEditInfo | null) ?? null
}

const columnsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** 100 rows per page, `order=row_index`; `page` is 0-based. */
export async function getJobRows(jobId: string, page: number): Promise<JobRowsPage> {
  const sb = createServiceClient()
  const job = await getJobEditInfo(jobId)
  const columns = columnsOf(job?.column_order)
  const editable = job?.finder_status === ROW_EDIT_FINDER_STATUS
  const edit = { editable, edit_block_reason: editable ? null : ROW_EDIT_BLOCKED_REASON }
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
      return { rows: [], total: c.count ?? 0, page: p, pageSize: ROWS_PAGE_SIZE, ...edit }
    }
    throw new DbError('getJobRows', res.error)
  }
  return {
    rows: ((res.data ?? []) as RawValidationRow[]).map((r) => toRowView(r, columns)),
    total: res.count ?? 0,
    page: p,
    pageSize: ROWS_PAGE_SIZE,
    ...edit,
  }
}

export type RowEditResult =
  | { ok: true; row: ValidationRowView; emailChanged: boolean; fields: string[] }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'job_running' }

/**
 * Edit a row before the validator can see it. Two guards:
 *  - job level: only while `finder_status='awaiting_decision'` (validator not
 *    invoked) → otherwise `job_running` (409);
 *  - row level: the update is conditional on `status='pending'`.
 * `row_data` keys are merged, not replaced. A new email is also written to
 * the job's email column inside `row_data` when that column exists there.
 */
export async function updatePendingRow(
  jobId: string,
  rowId: string,
  edit: { email?: string; row_data_patch?: Record<string, string | null> }
): Promise<RowEditResult> {
  const sb = createServiceClient()
  const job = await getJobEditInfo(jobId)
  if (!job) return { ok: false, reason: 'not_found' }
  if (job.finder_status !== ROW_EDIT_FINDER_STATUS) return { ok: false, reason: 'job_running' }

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
  const col = job.email_column
  if (emailChanged && col && row.row_data && col in row.row_data) patch[col] = edit.email!
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
  return {
    ok: true,
    row: toRowView(updated[0], columnsOf(job.column_order)),
    emailChanged,
    fields: Object.keys(edit.row_data_patch ?? {}),
  }
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

export type BarrierResult = 'ok' | 'moved' | 'push_awaiting_confirmation'

/**
 * Barrier / names-mode toggles, only while the push is being configured
 * (`moved` → 409). Refused while a push_to_instantly confirmation is
 * awaiting: the owner is confirming a snapshot of these settings.
 */
export async function setBarriers(jobId: string, patch: BarrierPatch): Promise<BarrierResult> {
  if (await findAwaitingAction('push_to_instantly', jobId)) return 'push_awaiting_confirmation'
  const sb = createServiceClient()
  const res = await sb
    .from('validation_jobs')
    .update(patch)
    .eq('id', jobId)
    .in('instantly_status', [...PUSH_REVIEW_STATUSES])
    .select('id')
  if (res.error) throw new DbError('setBarriers', res.error)
  return (res.data ?? []).length > 0 ? 'ok' : 'moved'
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
  instantly_pushed: number | null
} | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('validation_jobs')
    .select('id,filename,valid_count,instantly_status,instantly_campaign_id,instantly_campaign_name,location_barrier,company_barrier,company_strict,instantly_pushed')
    .eq('id', jobId)
    .maybeSingle()
  if (res.error) throw new DbError('getPushJob', res.error)
  return (res.data as never) ?? null
}

// ---------------------------------------------------------------------------
// Import intakes. Lume only creates the intake row (an ingest awaiting
// approval, or an Apollo order awaiting its count); telegram-inbox and the
// pipeline own every step after that. Lume never creates validation_jobs.

export async function insertIngest(row: TelegramIngestInsert): Promise<TelegramIngestRow> {
  const sb = createServiceClient()
  const res = await sb.from('telegram_ingests').insert(row).select('*').single()
  return unwrap('insertIngest', res) as TelegramIngestRow
}

export async function setIngestMessageId(id: string, messageId: number): Promise<void> {
  const sb = createServiceClient()
  const res = await sb.from('telegram_ingests').update({ telegram_message_id: messageId }).eq('id', id)
  if (res.error) throw new DbError('setIngestMessageId', res.error)
}

export async function insertApolloOrder(apolloUrl: string): Promise<ApolloOrderRow> {
  const sb = createServiceClient()
  const res = await sb.from('apollo_orders').insert({ apollo_url: apolloUrl, status: 'awaiting_count' }).select('*').single()
  return unwrap('insertApolloOrder', res) as ApolloOrderRow
}

export async function setApolloOrderMessageId(id: string, messageId: number): Promise<void> {
  const sb = createServiceClient()
  const res = await sb.from('apollo_orders').update({ telegram_message_id: messageId }).eq('id', id)
  if (res.error) throw new DbError('setApolloOrderMessageId', res.error)
}

export async function getIngest(id: string): Promise<TelegramIngestRow | null> {
  const sb = createServiceClient()
  const res = await sb.from('telegram_ingests').select('*').eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getIngest', res.error)
  return (res.data as TelegramIngestRow | null) ?? null
}

const APOLLO_ORDER_COLS =
  'id,apollo_url,contact_count,status,count_status,leadsfriday_order_id,leadsfriday_status,credits_deducted,new_balance,ingest_id,telegram_message_id,error,created_at'

export async function getApolloOrder(id: string): Promise<ApolloOrderRow | null> {
  const sb = createServiceClient()
  const res = await sb.from('apollo_orders').select(APOLLO_ORDER_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getApolloOrder', res.error)
  return (res.data as ApolloOrderRow | null) ?? null
}

const JOB_BATCH_COLS =
  'id,batch_date,status,companies_added,companies_pulled,companies_unresolved,contacts_total,contacts_kept,leadsfriday_order_id,leadsfriday_status,error,created_at'

export async function getJobBatch(id: string): Promise<JobBatchRow | null> {
  const sb = createServiceClient()
  const res = await sb.from('job_batches').select(JOB_BATCH_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getJobBatch', res.error)
  return (res.data as JobBatchRow | null) ?? null
}

/** A job's enrichment config and its first `n` rows' `row_data` (read-only). `null` when the job is gone. */
export async function getJobSample(jobId: string, n = 5): Promise<JobSampleSource | null> {
  const sb = createServiceClient()
  const jobRes = await sb
    .from('validation_jobs')
    .select('id,filename,status,total_rows,enrich,icp_filter,icp_description,column_order')
    .eq('id', jobId)
    .maybeSingle()
  if (jobRes.error) throw new DbError('getJobSample', jobRes.error)
  if (!jobRes.data) return null
  const rowsRes = await sb
    .from('validation_rows')
    .select('row_index,row_data')
    .eq('job_id', jobId)
    .order('row_index', { ascending: true })
    .order('id', { ascending: true })
    .limit(Math.min(Math.max(Math.floor(n), 1), 20))
  if (rowsRes.error) throw new DbError('getJobSample.rows', rowsRes.error)
  return { ...(jobRes.data as Omit<JobSampleSource, 'rows'>), rows: (rowsRes.data ?? []) as JobSampleSource['rows'] }
}

/** Open gates on any of these targets (an order, its job), oldest first. */
export async function getGatesForTargets(targetIds: string[]): Promise<GateRow[]> {
  const ids = targetIds.filter(Boolean)
  if (!ids.length) return []
  const sb = createServiceClient()
  const res = await sb
    .from('lume_gates')
    .select('*')
    .in('target_id', ids)
    .order('created_at', { ascending: true })
    .order('target_id', { ascending: true })
  return unwrap('getGatesForTargets', res) as GateRow[]
}

/** An ingest already pointing at this object (a re-submitted upload ticket). */
export async function findIngestByStoragePath(storagePath: string): Promise<{ id: string } | null> {
  const sb = createServiceClient()
  const res = await sb.from('telegram_ingests').select('id').eq('storage_path', storagePath).limit(1).maybeSingle()
  if (res.error) throw new DbError('findIngestByStoragePath', res.error)
  return (res.data as { id: string } | null) ?? null
}

// ---------------------------------------------------------------------------
// Rotate: rules, candidates, campaign queue depth, Instantly sync.
// Nothing here writes lead_bank: assignment is a pending action that Task 12's
// executor runs after a tap.

export async function getRules(): Promise<RotationRuleRow[]> {
  const sb = createServiceClient()
  const res = await sb.from('rotation_rules').select('*').order('created_at', { ascending: true }).order('id', { ascending: true })
  return unwrap('getRules', res) as RotationRuleRow[]
}

export async function getRule(id: string): Promise<RotationRuleRow | null> {
  const sb = createServiceClient()
  const res = await sb.from('rotation_rules').select('*').eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getRule', res.error)
  return (res.data as RotationRuleRow | null) ?? null
}

export type RuleInsert = Pick<RotationRuleRow, 'name' | 'campaign_id' | 'filter' | 'daily_cap' | 'order_by' | 'cron'>

/** Always inserted inactive: activation is a pending action (`activate_rule`). */
export async function insertRule(row: RuleInsert): Promise<RotationRuleRow> {
  const sb = createServiceClient()
  const res = await sb
    .from('rotation_rules')
    .insert({ ...row, filter: row.filter as unknown as Json, active: false, next_run_at: null })
    .select('*')
    .single()
  return unwrap('insertRule', res) as RotationRuleRow
}

/** `active` may only be set to false here; `null` when the rule is gone. */
export async function updateRule(
  id: string,
  patch: Partial<RuleInsert> & { active?: false; next_run_at?: string | null }
): Promise<RotationRuleRow | null> {
  const sb = createServiceClient()
  if ((patch as { active?: unknown }).active === true) throw new DbError('updateRule', new Error('active=true only via activate_rule'))
  const res = await sb.from('rotation_rules').update(patch).eq('id', id).select('*')
  if (res.error) throw new DbError('updateRule', res.error)
  return ((res.data ?? [])[0] as RotationRuleRow | undefined) ?? null
}

/** Deletes an inactive rule; `false` when it is active or gone. */
export async function deleteInactiveRule(id: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb.from('rotation_rules').delete().eq('id', id).eq('active', false).select('id')
  if (res.error) throw new DbError('deleteInactiveRule', res.error)
  return (res.data ?? []).length > 0
}

export type DueRule = Pick<RotationRuleRow, 'id' | 'name' | 'campaign_id' | 'filter' | 'daily_cap' | 'order_by' | 'cron' | 'next_run_at'>

/** Active rules whose `next_run_at` is unset or not after `nowIso`. */
export async function getDueRules(nowIso: string): Promise<DueRule[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('rotation_rules')
    .select('id,name,campaign_id,filter,daily_cap,order_by,cron,next_run_at')
    .eq('active', true)
    .or(`next_run_at.is.null,next_run_at.lte."${nowIso}"`)
    .order('next_run_at', { ascending: true, nullsFirst: true })
    .order('id', { ascending: true })
  return unwrap('getDueRules', res) as DueRule[]
}

/**
 * Claim a due rule by advancing it — the single conditional UPDATE the
 * rotation tick runs before anything else:
 *   update rotation_rules set next_run_at = $next, last_run_at = now()
 *    where id = $1 and active and (next_run_at is null or next_run_at <= now())
 *   returning id
 * `false` = another tick advanced it first (or it was paused): skip.
 */
export async function claimRule(id: string, nextRunAt: string, nowIso: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb
    .from('rotation_rules')
    .update({ next_run_at: nextRunAt, last_run_at: nowIso })
    .eq('id', id)
    .eq('active', true)
    .or(`next_run_at.is.null,next_run_at.lte."${nowIso}"`)
    .select('id')
  if (res.error) throw new DbError('claimRule', res.error)
  return (res.data ?? []).length > 0
}

export async function setRuleResult(id: string, result: Record<string, Json>): Promise<void> {
  const sb = createServiceClient()
  const res = await sb.from('rotation_rules').update({ last_result: result }).eq('id', id)
  if (res.error) throw new DbError('setRuleResult', res.error)
}

/** Open (awaiting) action of `kind` carrying `rule_id`, if any. */
export async function findAwaitingRuleAction(kind: PendingActionKind, ruleId: string): Promise<PendingActionRow | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .select('*')
    .eq('status', 'awaiting')
    .eq('kind', kind)
    .eq('rule_id', ruleId)
    .limit(1)
    .maybeSingle()
  if (res.error) throw new DbError('findAwaitingRuleAction', res.error)
  return (res.data as PendingActionRow | null) ?? null
}

/** Every awaiting action tied to a rule (the Rules table shows them). */
export async function getAwaitingRuleActions(): Promise<Pick<PendingActionRow, 'id' | 'kind' | 'rule_id' | 'created_at'>[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .select('id,kind,rule_id,created_at')
    .eq('status', 'awaiting')
    .not('rule_id', 'is', null)
    .order('created_at', { ascending: true })
  return unwrap('getAwaitingRuleActions', res) as Pick<PendingActionRow, 'id' | 'kind' | 'rule_id' | 'created_at'>[]
}

/** Exact count of `lume_lead_bank` candidates for `filter`, minus rows already queued for `campaignId`. */
export async function countCandidates(filter: RuleFilter, campaignId: string): Promise<number> {
  const sb = createServiceClient()
  type HeadQuery = RuleFilterQuery<HeadQuery> & PromiseLike<{ count: number | null; error: PostgrestError | null }>
  const q = sb.from('lume_lead_bank').select('id', { count: 'exact', head: true }) as unknown as HeadQuery
  const res = await applyFilter<HeadQuery>(q, filter, { campaignId })
  if (res.error) throw new DbError('countCandidates', res.error)
  return res.count ?? 0
}

export interface LeadRef {
  origin: 'lead_bank' | 'validation_rows'
  id: string
}

const RESOLVE_CHUNK = 100

/** The selected leads that still exist in `lume_lead_bank` and are not already queued for `campaignId`. */
export async function resolveLeadRefs(refs: LeadRef[], campaignId: string): Promise<LeadRef[]> {
  if (!refs.length) return []
  const sb = createServiceClient()
  const ids = [...new Set(refs.map((r) => r.id))]
  const rows: { origin: string; id: string; campaign_id: string | null }[] = []
  // 100 ids per lookup: a 5k-row selection in one `.in()` overflows the GET URL.
  for (let i = 0; i < ids.length; i += RESOLVE_CHUNK) {
    const res = await sb.from('lume_lead_bank').select('origin,id,campaign_id').in('id', ids.slice(i, i + RESOLVE_CHUNK))
    if (res.error) throw new DbError('resolveLeadRefs', res.error)
    rows.push(...((res.data ?? []) as { origin: string; id: string; campaign_id: string | null }[]))
  }
  const found = new Set(rows.filter((r) => r.campaign_id !== campaignId).map((r) => `${r.origin}:${r.id}`))
  const seen = new Set<string>()
  return refs.filter((r) => {
    const k = `${r.origin}:${r.id}`
    if (!found.has(k) || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * The lead and campaign of an Instantly email Lume saw via webhook
 * (`events.source_id` = Instantly email id). Null when no event carries it.
 */
export async function getInstantlyEmailEvent(emailId: string): Promise<{ lead_email: string; campaign_id: string | null } | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('events')
    .select('lead_email,campaign_id')
    .eq('source', 'instantly')
    .eq('source_id', emailId)
    .not('lead_email', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (res.error) throw new DbError('getInstantlyEmailEvent', res.error)
  return (res.data as { lead_email: string; campaign_id: string | null } | null) ?? null
}

export async function getCampaignByExternalId(externalId: string): Promise<LumeCampaignRow | null> {
  const sb = createServiceClient()
  const res = await sb.from('lume_campaigns').select('*').eq('external_id', externalId).limit(1).maybeSingle()
  if (res.error) throw new DbError('getCampaignByExternalId', res.error)
  return (res.data as LumeCampaignRow | null) ?? null
}

/** `lead_bank` rows in `queued` per campaign id (head-only counts; a handful of campaigns). */
export async function getQueuedCounts(campaignIds: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(campaignIds.filter(Boolean))]
  const sb = createServiceClient()
  const pairs = await Promise.all(
    ids.map(async (id) => {
      const r = await sb.from('lead_bank').select('id', { count: 'exact', head: true }).eq('campaign_id', id).eq('state', 'queued')
      if (r.error) throw new DbError('getQueuedCounts', r.error)
      return [id, r.count ?? 0] as const
    })
  )
  return Object.fromEntries(pairs)
}

/**
 * Upsert Instantly campaigns into `lume_campaigns` on (sender_type,
 * external_id). New rows land as family 'other'; existing rows keep the
 * family the owner set. Campaigns missing from Instantly are left alone.
 */
export async function syncInstantlyCampaigns(
  campaigns: InstantlyCampaignDetail[],
  nowIso: string
): Promise<{ inserted: number; updated: number }> {
  if (!campaigns.length) return { inserted: 0, updated: 0 }
  const sb = createServiceClient()
  const existing = await sb.from('lume_campaigns').select('external_id,family').eq('sender_type', 'instantly')
  if (existing.error) throw new DbError('syncInstantlyCampaigns.read', existing.error)
  const family = new Map(((existing.data ?? []) as { external_id: string | null; family: string }[]).map((r) => [r.external_id, r.family]))
  const rows = campaigns.map((c) => ({
    sender_type: 'instantly',
    external_id: c.id,
    name: c.name,
    family: family.get(c.id) ?? 'other',
    status: lumeCampaignStatus(c.status),
    capacity_per_day: c.dailyLimit,
    instantly: { status: c.status, daily_limit: c.dailyLimit, accounts: c.accounts } as Json,
    synced_at: nowIso,
  }))
  const res = await sb.from('lume_campaigns').upsert(rows, { onConflict: 'sender_type,external_id' }).select('id')
  if (res.error) throw new DbError('syncInstantlyCampaigns', res.error)
  const inserted = campaigns.filter((c) => !family.has(c.id)).length
  return { inserted, updated: campaigns.length - inserted }
}

/**
 * Expire awaiting actions created before `cutoffIso`: `status='expired'` and
 * the claim slot taken, so a late Telegram or Lume tap finds nothing to claim.
 */
export async function expireStaleActions(
  cutoffIso: string
): Promise<Pick<PendingActionRow, 'id' | 'kind' | 'telegram_message_id' | 'payload'>[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .update({ status: 'expired', claim_status: 'claimed' })
    .eq('status', 'awaiting')
    .eq('claim_status', 'awaiting')
    .lt('created_at', cutoffIso)
    .select('id,kind,telegram_message_id,payload')
  if (res.error) throw new DbError('expireStaleActions', res.error)
  return (res.data ?? []) as Pick<PendingActionRow, 'id' | 'kind' | 'telegram_message_id' | 'payload'>[]
}
