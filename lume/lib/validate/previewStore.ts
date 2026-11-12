import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { CAMPAIGN_CHOICE_STATUSES, DbError, ROW_EDIT_BLOCKED_REASON, ROW_EDIT_FINDER_STATUS } from '@/lib/db/service'
import { csvCell } from '@/lib/csv/cell'
import { ROW_STATUSES } from '@/lib/validate/rows'
import { invalidRate } from '@/lib/validate/stats'
import {
  jobName,
  pageBounds,
  PREVIEW_PAGE_SIZE,
  previewColumns,
  searchPattern,
  toPreviewRow,
  type PreviewCounts,
  type PreviewFilter,
  type PreviewJob,
  type PreviewPage,
  type PreviewQuery,
  type RawPreviewRow,
  type ValidatedListRow,
  applySentCompanyNames,
  emailCompanyColumn,
} from '@/lib/validate/preview'

/**
 * Reads behind the validated-leads preview and the rename. Read-only on
 * pipeline state: the only write is `validation_jobs.display_name`, a label
 * the validator never reads (Lume never creates jobs or moves their state).
 */

const JOB_COLS =
  'id,filename,display_name,status,total_rows,created_at,enrich,column_order,finder_status,instantly_status,instantly_campaign_id,instantly_campaign_name'
const ROW_COLS = 'id,row_index,email,status,validation_result,enrichment_status,enrichment,instantly_status,row_data'

type JobRecord = PreviewJob & { column_order: unknown; finder_status: string | null }

function toJob(j: Record<string, unknown>): JobRecord {
  const display = typeof j.display_name === 'string' && j.display_name.trim() ? j.display_name : null
  const base = {
    id: String(j.id),
    filename: (j.filename as string | null) ?? null,
    display_name: display,
    status: (j.status as string | null) ?? null,
    total_rows: typeof j.total_rows === 'number' ? j.total_rows : 0,
    created_at: String(j.created_at),
    enrich: j.enrich === true,
    instantly_status: (j.instantly_status as string | null) ?? null,
    instantly_campaign_id: (j.instantly_campaign_id as string | null) ?? null,
    instantly_campaign_name: (j.instantly_campaign_name as string | null) ?? null,
  }
  return { ...base, name: jobName(base), column_order: j.column_order, finder_status: (j.finder_status as string | null) ?? null }
}

/** The job as the browser sees it (no column_order / finder_status). */
function publicJob(j: JobRecord): PreviewJob {
  return {
    id: j.id,
    name: j.name,
    filename: j.filename,
    display_name: j.display_name,
    status: j.status,
    total_rows: j.total_rows,
    created_at: j.created_at,
    enrich: j.enrich,
    instantly_status: j.instantly_status,
    instantly_campaign_id: j.instantly_campaign_id,
    instantly_campaign_name: j.instantly_campaign_name,
  }
}

export async function getPreviewJob(id: string): Promise<JobRecord | null> {
  const res = await createServiceClient().from('validation_jobs').select(JOB_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getPreviewJob', res.error)
  return res.data ? toJob(res.data as unknown as Record<string, unknown>) : null
}

/** Head-only exact counts per status (no rows move). */
async function statusCounts(jobId: string): Promise<PreviewCounts> {
  const sb = createServiceClient()
  const pairs = await Promise.all(
    ROW_STATUSES.map(async (s) => {
      const r = await sb.from('validation_rows').select('id', { count: 'exact', head: true }).eq('job_id', jobId).eq('status', s)
      if (r.error) throw new DbError(`previewCounts.${s}`, r.error)
      return [s, r.count ?? 0] as const
    })
  )
  const c = Object.fromEntries(pairs) as Omit<PreviewCounts, 'all'>
  return { ...c, all: c.valid + c.invalid + c.error + c.no_email + c.pending }
}

const statusOf = (f: PreviewFilter) => (f === 'all' ? null : f)

async function readRows(jobId: string, q: PreviewQuery, total: number): Promise<{ rows: RawPreviewRow[]; total: number }> {
  const sb = createServiceClient()
  const { from, past } = pageBounds(q.page, total)
  if (q.q) {
    const res = await sb.rpc('lume_validation_rows_search', {
      p_job: jobId,
      p_status: statusOf(q.status),
      p_pattern: searchPattern(q.q),
      p_offset: from,
      p_limit: PREVIEW_PAGE_SIZE,
    })
    if (res.error) throw new DbError('previewRows.search', res.error)
    const d = (res.data ?? {}) as { total?: number; rows?: RawPreviewRow[] }
    return { rows: d.rows ?? [], total: Number(d.total) || 0 }
  }
  if (past) return { rows: [], total }
  let query = sb.from('validation_rows').select(ROW_COLS).eq('job_id', jobId)
  const s = statusOf(q.status)
  if (s) query = query.eq('status', s)
  const res = await query.order('row_index', { ascending: true }).order('id', { ascending: true }).range(from, from + PREVIEW_PAGE_SIZE - 1)
  if (res.error) throw new DbError('previewRows', res.error)
  return { rows: (res.data ?? []) as unknown as RawPreviewRow[], total }
}

/**
 * Lowercased email → the company name this job banked or pushed for it
 * (lead_bank, written by instantly-push after the company-name SOP). Rows the
 * job never banked are absent and keep their CSV value.
 */
async function sentCompanyNames(jobId: string, rows: readonly RawPreviewRow[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const emails = [...new Set(rows.filter((r) => r.instantly_status === 'banked' || r.instantly_status === 'pushed').map((r) => r.email?.trim().toLowerCase()).filter((e): e is string => !!e))]
  if (!emails.length) return out
  const res = await createServiceClient().from('lead_bank').select('email,company_name').eq('source_job_id', jobId).in('email', emails)
  if (res.error) throw new DbError('sentCompanyNames', res.error)
  for (const r of (res.data ?? []) as { email: string; company_name: string | null }[]) out.set(r.email.toLowerCase(), r.company_name)
  return out
}

/** One page of the preview; `null` when the job does not exist. */
export async function getPreviewPage(jobId: string, q: PreviewQuery): Promise<PreviewPage | null> {
  const job = await getPreviewJob(jobId)
  if (!job) return null
  const counts = await statusCounts(jobId)
  const { rows, total } = await readRows(jobId, q, counts[q.status])
  const columns = previewColumns(job.column_order, job.enrich, rows)
  const editable = job.finder_status === ROW_EDIT_FINDER_STATUS
  const pub = publicJob(job)
  const companyCol = emailCompanyColumn(columns.original)
  const sent = companyCol === null ? new Map<string, string | null>() : await sentCompanyNames(jobId, rows)
  return {
    job: pub,
    columns,
    email_company_col: companyCol,
    rows: applySentCompanyNames(rows.map((r) => toPreviewRow(r, columns, editable)), companyCol, sent),
    total,
    page: q.page,
    page_size: PREVIEW_PAGE_SIZE,
    status: q.status,
    q: q.q,
    counts,
    editable,
    edit_block_reason: editable ? null : ROW_EDIT_BLOCKED_REASON,
  }
}

/** `null` when the job does not exist. */
export async function renameJob(id: string, displayName: string | null): Promise<PreviewJob | null> {
  const res = await createServiceClient().from('validation_jobs').update({ display_name: displayName }).eq('id', id).select(JOB_COLS).maybeSingle()
  if (res.error) throw new DbError('renameJob', res.error)
  if (!res.data) return null
  return publicJob(toJob(res.data as unknown as Record<string, unknown>))
}

/** Job id → display name, for the jobs that have one (titles in history and gates). */
export async function displayNamesFor(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(ids)]
  if (!uniq.length) return out
  const res = await createServiceClient().from('validation_jobs').select('id,display_name').in('id', uniq).not('display_name', 'is', null)
  if (res.error) throw new DbError('displayNamesFor', res.error)
  for (const r of (res.data ?? []) as { id: string; display_name: string | null }[]) if (r.display_name?.trim()) out.set(r.id, r.display_name)
  return out
}

const LIST_COLS = 'id,filename,display_name,status,total_rows,created_at,valid_count,invalid_count,instantly_status,instantly_campaign_id,instantly_campaign_name,instantly_banked'
const CHOICE = new Set<string>(CAMPAIGN_CHOICE_STATUSES)

function toListRow(j: Record<string, unknown>): ValidatedListRow {
  const valid = typeof j.valid_count === 'number' ? j.valid_count : 0
  const invalid = typeof j.invalid_count === 'number' ? j.invalid_count : 0
  const display = typeof j.display_name === 'string' && j.display_name.trim() ? j.display_name : null
  const total = typeof j.total_rows === 'number' ? j.total_rows : 0
  const status = (j.instantly_status as string | null) ?? null
  return {
    id: String(j.id),
    name: jobName({ display_name: display, total_rows: total, created_at: String(j.created_at) }),
    filename: (j.filename as string | null) ?? null,
    display_name: display,
    created_at: String(j.created_at),
    total_rows: total,
    valid,
    invalid,
    invalid_rate: invalidRate(valid, invalid),
    status: (j.status as string | null) ?? null,
    instantly_status: status,
    instantly_campaign_id: (j.instantly_campaign_id as string | null) ?? null,
    instantly_campaign_name: (j.instantly_campaign_name as string | null) ?? null,
    unassigned: CHOICE.has(status ?? ''),
    banked: typeof j.instantly_banked === 'number' ? j.instantly_banked : 0,
  }
}

/**
 * Validated lists for a campaign: jobs whose Instantly campaign is
 * `campaignId` (picked or pushed), plus (with `unassigned`) jobs still
 * waiting for a campaign pick. Newest first, at most 100 of each.
 */
export async function listValidatedJobs(opts: { campaignId: string | null; unassigned: boolean }): Promise<ValidatedListRow[]> {
  const sb = createServiceClient()
  const byCampaign = async () => {
    if (!opts.campaignId) return []
    const r = await sb.from('validation_jobs').select(LIST_COLS).eq('instantly_campaign_id', opts.campaignId).order('created_at', { ascending: false }).limit(100)
    if (r.error) throw new DbError('listValidatedJobs.campaign', r.error)
    return (r.data ?? []) as Record<string, unknown>[]
  }
  const waiting = async () => {
    if (!opts.unassigned) return []
    const r = await sb.from('validation_jobs').select(LIST_COLS).in('instantly_status', [...CAMPAIGN_CHOICE_STATUSES]).order('created_at', { ascending: false }).limit(100)
    if (r.error) throw new DbError('listValidatedJobs.unassigned', r.error)
    return (r.data ?? []) as Record<string, unknown>[]
  }
  const seen = new Map<string, ValidatedListRow>()
  for (const j of (await Promise.all([byCampaign(), waiting()])).flat()) seen.set(String(j.id), toListRow(j))
  return [...seen.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
}

/** CSV header + lines of a job's rows (`valid` or `all`), streamed 1,000 rows at a time in row_index order. */
export async function* previewCsvChunks(job: JobRecord, status: 'valid' | 'all', pageSize = 1000): AsyncGenerator<string> {
  const sb = createServiceClient()
  let columns: ReturnType<typeof previewColumns> | null = null
  for (let from = 0; ; from += pageSize) {
    let query = sb.from('validation_rows').select(ROW_COLS).eq('job_id', job.id)
    if (status === 'valid') query = query.eq('status', 'valid')
    const res = await query.order('row_index', { ascending: true }).order('id', { ascending: true }).range(from, from + pageSize - 1)
    if (res.error) throw new DbError('previewCsv', res.error)
    const page = (res.data ?? []) as unknown as RawPreviewRow[]
    if (!columns) {
      columns = previewColumns(job.column_order, job.enrich, page)
      yield [...columns.original, 'Status', 'Reason', ...columns.enrichment.map((c) => c.label)].map(csvCell).join(',') + '\n'
    }
    const cols = columns
    if (page.length) {
      yield page
        .map((r) => {
          const v = toPreviewRow(r, cols)
          return [...v.cells, v.status_label, v.reason, ...v.enrichment].map(csvCell).join(',')
        })
        .join('\n') + '\n'
    }
    if (page.length < pageSize) return
  }
}

export type { JobRecord }
