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
  type SendCounts,
  type SendFilter,
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

const NO_SEND_COUNTS: SendCounts = { sending: 0, pulled: 0, banked: 0, all: 0 }

/**
 * One page of rows through lume_validation_rows_page: each row with its
 * sending state (the job's lead bank rows by email, or the direct push) and
 * the company name the bank holds, filtered by status, sending tab and search.
 */
async function readRows(
  jobId: string,
  q: { status: PreviewFilter; send: SendFilter; q: string | null },
  offset: number,
  limit: number
): Promise<{ rows: RawPreviewRow[]; total: number; send_counts: SendCounts }> {
  const res = await createServiceClient().rpc('lume_validation_rows_page', {
    p_job: jobId,
    p_status: statusOf(q.status),
    p_send: q.send === 'all' ? null : q.send,
    p_pattern: q.q ? searchPattern(q.q) : null,
    p_offset: offset,
    p_limit: limit,
  })
  if (res.error) throw new DbError('previewRows', res.error)
  const d = (res.data ?? {}) as { total?: number; rows?: RawPreviewRow[]; send_counts?: Partial<SendCounts> }
  return { rows: d.rows ?? [], total: Number(d.total) || 0, send_counts: { ...NO_SEND_COUNTS, ...d.send_counts } }
}

/**
 * Lowercased email → the company name the job banked for it (lead_bank,
 * cleaned by the company-name SOP at push time). Rows the job never banked
 * are absent and keep their CSV value.
 */
function sentCompanyNames(rows: readonly RawPreviewRow[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const r of rows) {
    const email = r.email?.trim().toLowerCase()
    if (email && r.bank_company !== undefined && r.bank_company !== null) out.set(email, r.bank_company)
  }
  return out
}

/** One page of the preview; `null` when the job does not exist. */
export async function getPreviewPage(jobId: string, q: PreviewQuery): Promise<PreviewPage | null> {
  const job = await getPreviewJob(jobId)
  if (!job) return null
  const { from } = pageBounds(q.page, Number.MAX_SAFE_INTEGER)
  const [counts, read] = await Promise.all([statusCounts(jobId), readRows(jobId, q, from, PREVIEW_PAGE_SIZE)])
  const { rows, total, send_counts } = read
  const columns = previewColumns(job.column_order, job.enrich, rows)
  const editable = job.finder_status === ROW_EDIT_FINDER_STATUS
  const pub = publicJob(job)
  const companyCol = emailCompanyColumn(columns.original)
  return {
    job: pub,
    columns,
    email_company_col: companyCol,
    rows: applySentCompanyNames(rows.map((r) => toPreviewRow(r, columns, editable)), companyCol, sentCompanyNames(rows)),
    total,
    page: q.page,
    page_size: PREVIEW_PAGE_SIZE,
    status: q.status,
    q: q.q,
    send: q.send,
    send_counts,
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

/**
 * CSV header + lines of a job's rows (`valid` or `all`, narrowed to a sending
 * tab), streamed 1,000 rows at a time in row_index order. "Company Name for
 * Emails" carries the name that is sent; a Sending column follows Status
 * once the job has pushed or banked anything.
 */
export async function* previewCsvChunks(job: JobRecord, status: 'valid' | 'all', send: SendFilter = 'all', pageSize = 1000): AsyncGenerator<string> {
  let columns: ReturnType<typeof previewColumns> | null = null
  let companyCol: number | null = null
  let withSend = false
  for (let from = 0; ; from += pageSize) {
    const { rows: page, send_counts } = await readRows(job.id, { status, send, q: null }, from, pageSize)
    if (!columns) {
      columns = previewColumns(job.column_order, job.enrich, page)
      companyCol = emailCompanyColumn(columns.original)
      withSend = send_counts.banked > 0
      yield [...columns.original, 'Status', 'Reason', ...(withSend ? ['Sending'] : []), ...columns.enrichment.map((c) => c.label)].map(csvCell).join(',') + '\n'
    }
    const cols = columns
    if (page.length) {
      const views = applySentCompanyNames(page.map((r) => toPreviewRow(r, cols)), companyCol, sentCompanyNames(page))
      yield views
        .map((v) => [...v.cells, v.status_label, v.reason, ...(withSend ? [v.send_label] : []), ...v.enrichment].map(csvCell).join(','))
        .join('\n') + '\n'
    }
    if (page.length < pageSize) return
  }
}

export type { JobRecord }
