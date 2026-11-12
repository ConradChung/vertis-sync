import { z } from 'zod'
import { jobName } from '@/lib/validate/jobs'
import { toRowView, type ValidationRowView } from '@/lib/validate/rows'

/**
 * The validated-leads preview (pure, client-safe): one job's rows with the
 * original CSV columns in `column_order` order, then Status (+ MailTester
 * reason), then the enrichment columns the CSV does not already carry.
 * Read by GET /api/validation-jobs/[id]/rows and components/validate/ValidatedPreview.
 */

export const PREVIEW_FILTERS = ['valid', 'invalid', 'error', 'all'] as const
export type PreviewFilter = (typeof PREVIEW_FILTERS)[number]
/** Sending tabs (lead bank state, or the direct push): what is going out, what was pulled, everything. */
export const SEND_FILTERS = ['sending', 'pulled', 'all'] as const
export type SendFilter = (typeof SEND_FILTERS)[number]
export const PREVIEW_PAGE_SIZE = 100
/** Pages beyond this are refused (100 rows each: a million rows). */
export const PREVIEW_MAX_PAGE = 9_999
export const DISPLAY_NAME_MAX = 120
export const SEARCH_MAX = 100

export const STATUS_LABEL: Record<string, string> = {
  valid: 'Valid',
  invalid: 'Invalid',
  error: 'Error',
  no_email: 'No email',
  pending: 'Pending',
}
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, ' ')

/** `send_state` from lume_validation_rows_page → the Sending column. */
export const SEND_LABEL: Record<string, string> = {
  queued: 'Queued',
  in_instantly: 'In Instantly',
  replied: 'Replied',
  pulled: 'Pulled',
  finished: 'Finished',
  bounced: 'Bounced',
  unsubscribed: 'Unsubscribed',
  filtered: 'Filtered',
  not_sent: 'Not sent',
}
export const sendLabel = (s: string | null | undefined) => (s ? (SEND_LABEL[s] ?? s.replace(/_/g, ' ')) : null)

/**
 * Enrichment output (validation_rows.enrichment) shown after Status, unless
 * the CSV already carries it (the validator writes the city back into
 * row_data for enriched jobs, so `operating_city` is usually an original column).
 */
export const ENRICH_COLUMNS = [
  { key: 'operating_city', label: 'Operating city', csv: ['operating_city'] },
  { key: 'secondary_cities', label: 'Secondary cities', csv: ['secondary_cities'] },
  { key: 'confidence', label: 'City confidence', csv: ['city_confidence', 'confidence'] },
  { key: 'icp_status', label: 'ICP', csv: ['icp_status'] },
] as const

export interface PreviewColumns {
  /** Original CSV headers (row_data keys), in the CSV's order. */
  original: string[]
  /** Enrichment keys (validation_rows.enrichment) with their labels. */
  enrichment: { key: string; label: string }[]
}

export interface RawPreviewRow {
  id: string
  row_index: number
  email: string | null
  status: string
  validation_result: { message?: unknown; code?: unknown } | null
  enrichment_status: string | null
  enrichment?: unknown
  instantly_status: string | null
  row_data: Record<string, unknown> | null
  /** From lume_validation_rows_page: the row's sending state and the company name the bank holds for it. */
  send_state?: string | null
  bank_company?: string | null
}

export interface PreviewRow {
  id: string
  row_index: number
  email: string | null
  status: string
  status_label: string
  /** MailTester's message (e.g. "Accepted", "Catch-All", "MX Error"). */
  reason: string | null
  /** One per `columns.original`. */
  cells: (string | null)[]
  /** One per `columns.enrichment`. */
  enrichment: (string | null)[]
  /** The row editor's view; only while the job's rows are editable (finder prompt). */
  edit?: ValidationRowView
  /** The CSV's "Company Name for Emails" value, when that cell shows a different, cleaned name (the one sent). */
  company_original?: string | null
  /** Sending state (SEND_LABEL key) and its label. */
  send_state: string | null
  send_label: string | null
}

export interface SendCounts {
  sending: number
  pulled: number
  /** Rows the job pushed or banked at all; 0 hides the Sending tabs and column. */
  banked: number
  all: number
}

export interface PreviewCounts {
  valid: number
  invalid: number
  error: number
  no_email: number
  pending: number
  all: number
}

export interface PreviewJob {
  id: string
  name: string
  filename: string | null
  display_name: string | null
  status: string | null
  total_rows: number
  created_at: string
  enrich: boolean
  instantly_status: string | null
  instantly_campaign_id: string | null
  instantly_campaign_name: string | null
}

export interface PreviewPage {
  job: PreviewJob
  columns: PreviewColumns
  rows: PreviewRow[]
  /** Rows matching the filter and search. */
  total: number
  page: number
  page_size: number
  status: PreviewFilter
  q: string | null
  /** Per status for the whole job (search does not narrow these). */
  counts: PreviewCounts
  editable: boolean
  edit_block_reason: string | null
  /** Index in `columns.original` of the "Company Name for Emails" column, when there is one. */
  email_company_col: number | null
  send: SendFilter
  /** Per sending tab, within the status filter (search does not narrow these). */
  send_counts: SendCounts
}

const columnsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

/** `column_order` when the job has one; else the row_data keys of the page, first seen first. */
export function previewColumns(columnOrder: unknown, enrich: boolean, rows: readonly Pick<RawPreviewRow, 'row_data'>[] = []): PreviewColumns {
  let original = [...new Set(columnsOf(columnOrder))]
  if (!original.length) {
    const seen = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.row_data ?? {})) seen.add(k)
    original = [...seen]
  }
  const have = new Set(original.map((c) => c.toLowerCase()))
  const enrichment = enrich ? ENRICH_COLUMNS.filter((c) => !c.csv.some((k) => have.has(k))).map(({ key, label }) => ({ key, label })) : []
  return { original, enrichment }
}

/** A cell as text: strings as is, numbers / booleans printed, objects as JSON, empty → null. */
export function cellText(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim() === '' ? null : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.length ? v.map((x) => cellText(x) ?? '').filter(Boolean).join(', ') || null : null
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}

export function toPreviewRow(r: RawPreviewRow, columns: PreviewColumns, editable = false): PreviewRow {
  const data = r.row_data ?? {}
  const enr = r.enrichment && typeof r.enrichment === 'object' && !Array.isArray(r.enrichment) ? (r.enrichment as Record<string, unknown>) : {}
  const row: PreviewRow = {
    id: r.id,
    row_index: r.row_index,
    email: r.email,
    status: r.status,
    status_label: statusLabel(r.status),
    reason: cellText(r.validation_result?.message),
    cells: columns.original.map((c) => cellText(data[c])),
    enrichment: columns.enrichment.map((c) => cellText(enr[c.key])),
    send_state: r.send_state ?? null,
    send_label: sendLabel(r.send_state),
  }
  if (editable) row.edit = toRowView({ ...r, validation_result: r.validation_result }, columns.original)
  return row
}

const EMAIL_COMPANY_KEYS = new Set(['companynameforemails', 'companyforemails', 'companynameforemail'])

/**
 * Index in `original` of the "Company Name for Emails" column (Apollo's
 * export), ignoring case, spaces, `_` and `-`; null when the CSV has none.
 * The raw "Company Name" column is never rewritten.
 */
export function emailCompanyColumn(original: readonly string[]): number | null {
  const i = original.findIndex((c) => EMAIL_COMPANY_KEYS.has(c.trim().toLowerCase().replace(/[\s_-]+/g, '')))
  return i >= 0 ? i : null
}

/**
 * Show the company name that is sent (lead_bank.company_name, cleaned by the
 * cold-email SOP at push time) in the "Company Name for Emails" cell of rows
 * that have one, keeping the CSV's value on `company_original`. `sent` is
 * keyed by lowercased email.
 */
export function applySentCompanyNames(rows: PreviewRow[], col: number | null, sent: ReadonlyMap<string, string | null>): PreviewRow[] {
  if (col === null || sent.size === 0) return rows
  return rows.map((r) => {
    const email = r.email?.trim().toLowerCase()
    if (!email || !sent.has(email)) return r
    const name = sent.get(email) ?? null
    const original = r.cells[col] ?? null
    if (name === original) return r
    const cells = [...r.cells]
    cells[col] = name
    return { ...r, cells, company_original: original }
  })
}

/**
 * The search term: trimmed, at most SEARCH_MAX chars, without `"`, `\` and
 * control characters (the SQL prefilter matches row_data::text, where those
 * are escaped). `null` when nothing is left.
 */
export function searchTerm(q: string | null | undefined): string | null {
  const s = (q ?? '').replace(/["\\\u0000-\u001f\u007f]/g, '').trim().slice(0, SEARCH_MAX).trim()
  return s || null
}

/** `%term%` for ILIKE with `%` and `_` escaped (`\` is the default escape; the term has none). */
export const searchPattern = (term: string) => `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`

export type PreviewQuery = { page: number; status: PreviewFilter; q: string | null; send: SendFilter }

/** `?send=` → the sending tab (default all), or null when unknown. */
export function parseSend(raw: string | null): SendFilter | null {
  const send = (raw ?? 'all') as SendFilter
  return SEND_FILTERS.includes(send) ? send : null
}

/** `?page=&status=&q=&send=` → the query, or an error code. Status defaults to valid, send to all. */
export function parsePreviewQuery(sp: URLSearchParams): { ok: true; query: PreviewQuery } | { ok: false; error: 'bad_page' | 'bad_status' | 'bad_send' } {
  const rawPage = sp.get('page') ?? '0'
  if (!/^\d{1,6}$/.test(rawPage) || Number(rawPage) > PREVIEW_MAX_PAGE) return { ok: false, error: 'bad_page' }
  const status = (sp.get('status') ?? 'valid') as PreviewFilter
  if (!PREVIEW_FILTERS.includes(status)) return { ok: false, error: 'bad_status' }
  const send = parseSend(sp.get('send'))
  if (!send) return { ok: false, error: 'bad_send' }
  return { ok: true, query: { page: Number(rawPage), status, q: searchTerm(sp.get('q')), send } }
}

/** Row offset of a page, and whether it lies past the total (no query needed). */
export function pageBounds(page: number, total: number, size = PREVIEW_PAGE_SIZE): { from: number; to: number; past: boolean } {
  const from = Math.max(0, Math.floor(page)) * size
  return { from, to: from + size - 1, past: from >= total }
}

/** PATCH body: a name of 1–120 characters, or empty / null to go back to the filename. */
export const DisplayNameBody = z
  .object({ display_name: z.string().max(1000).nullable() })
  .strict()
  .transform((b) => ({ display_name: b.display_name?.replace(/\s+/g, ' ').trim() || null }))
  .refine((b) => b.display_name === null || b.display_name.length <= DISPLAY_NAME_MAX, 'too long')

export { jobName }

/** Rows of a list for the Campaigns → CRM "Validated lists" section. */
export interface ValidatedListRow {
  id: string
  name: string
  filename: string | null
  display_name: string | null
  created_at: string
  total_rows: number
  valid: number
  invalid: number
  invalid_rate: number | null
  status: string | null
  instantly_status: string | null
  instantly_campaign_id: string | null
  instantly_campaign_name: string | null
  /** Leads sent to the lead bank by the push (over the bank threshold), 0 for a direct push. */
  banked?: number
  /** True while the job waits for a campaign pick. */
  unassigned: boolean
}
