import type { ApolloOrderRow, GateKind, GateRow, JobBatchRow, JobSampleSource, OrderKind, TelegramIngestRow } from '@/lib/db/types'
import type { CsvSample } from '@/lib/import/csv'

/**
 * `GET /api/orders?id=&kind=` detail, per kind. Pure mapping from the rows
 * the route reads; everything here is read-only display data.
 */

export const ORDER_KINDS: readonly OrderKind[] = ['ingest', 'apollo_order', 'job_batch', 'dashboard_job']

export interface EnrichmentConfig {
  enrich: boolean
  icp_filter: boolean
  icp_description: string | null
}

/** The open gate for this order (or its job), as a Validate deep-link value. */
export interface OrderGate {
  kind: GateKind
  target_id: string
  /** `?gate=` value: `<kind>:<target_id>`. */
  param: string
}

interface Base {
  id: string
  status: string | null
  gate: OrderGate | null
}

export type OrderDetail =
  | (Base & {
      kind: 'ingest'
      filename: string
      source: string
      row_count: number | null
      email_column: string | null
      validation_job_id: string | null
      /** From Storage before approval; from validation_rows once a job exists. */
      sample: CsvSample | null
      sample_from: 'file' | 'job' | null
      enrichment: EnrichmentConfig | null
    })
  | (Base & {
      kind: 'dashboard_job'
      filename: string | null
      row_count: number | null
      sample: CsvSample | null
      enrichment: EnrichmentConfig | null
    })
  | (Base & {
      kind: 'apollo_order'
      apollo_url: string | null
      contact_count: number | null
      credits_deducted: number | null
      new_balance: number | null
      leadsfriday_order_id: number | null
      leadsfriday_status: string | null
      ingest_id: string | null
      error: string | null
      /** The count picker shows only while this is true. */
      awaiting_count: boolean
    })
  | (Base & {
      kind: 'job_batch'
      batch_date: string
      counts: {
        companies_added: number
        companies_pulled: number
        companies_unresolved: number
        contacts_total: number
        contacts_kept: number
      }
      leadsfriday_order_id: number | null
      leadsfriday_status: string | null
      error: string | null
    })

export function toOrderGate(gates: readonly Pick<GateRow, 'kind' | 'target_id'>[]): OrderGate | null {
  const g = gates[0]
  return g ? { kind: g.kind, target_id: g.target_id, param: `${g.kind}:${g.target_id}` } : null
}

const columnsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function display(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** First rows' `row_data` as a table: columns from `column_order`, else first-seen keys. */
export function jobSample(job: Pick<JobSampleSource, 'column_order' | 'rows'>): CsvSample | null {
  if (!job.rows.length) return null
  let headers = columnsOf(job.column_order)
  if (!headers.length) {
    const seen = new Set<string>()
    for (const r of job.rows) for (const k of Object.keys(r.row_data ?? {})) seen.add(k)
    headers = [...seen]
  }
  return { headers, rows: job.rows.map((r) => headers.map((h) => display(r.row_data?.[h]))) }
}

export function jobEnrichment(job: Pick<JobSampleSource, 'enrich' | 'icp_filter' | 'icp_description'>): EnrichmentConfig {
  return { enrich: job.enrich === true, icp_filter: job.icp_filter === true, icp_description: job.icp_description ?? null }
}

export function ingestDetail(
  ingest: TelegramIngestRow,
  opts: { fileSample: CsvSample | null; job: JobSampleSource | null; gates: readonly GateRow[] }
): OrderDetail {
  const fromJob = opts.job ? jobSample(opts.job) : null
  const sample = fromJob ?? opts.fileSample
  return {
    kind: 'ingest',
    id: ingest.id,
    status: ingest.status,
    filename: ingest.filename,
    source: ingest.sender_platform,
    row_count: ingest.row_count,
    email_column: ingest.detected_email_column,
    validation_job_id: ingest.validation_job_id,
    sample,
    sample_from: fromJob ? 'job' : opts.fileSample ? 'file' : null,
    enrichment: opts.job ? jobEnrichment(opts.job) : null,
    gate: toOrderGate(opts.gates),
  }
}

export function dashboardJobDetail(job: JobSampleSource, gates: readonly GateRow[]): OrderDetail {
  return {
    kind: 'dashboard_job',
    id: job.id,
    status: job.status,
    filename: job.filename,
    row_count: job.total_rows,
    sample: jobSample(job),
    enrichment: jobEnrichment(job),
    gate: toOrderGate(gates),
  }
}

export function apolloOrderDetail(o: ApolloOrderRow, gates: readonly GateRow[]): OrderDetail {
  return {
    kind: 'apollo_order',
    id: o.id,
    status: o.status,
    apollo_url: o.apollo_url,
    contact_count: o.contact_count,
    credits_deducted: o.credits_deducted === null ? null : Number(o.credits_deducted),
    new_balance: o.new_balance === null ? null : Number(o.new_balance),
    leadsfriday_order_id: o.leadsfriday_order_id === null ? null : Number(o.leadsfriday_order_id),
    leadsfriday_status: o.leadsfriday_status,
    ingest_id: o.ingest_id,
    error: o.error,
    awaiting_count: o.status === 'awaiting_count' && o.count_status === 'awaiting',
    gate: toOrderGate(gates),
  }
}

export function jobBatchDetail(b: JobBatchRow, gates: readonly GateRow[]): OrderDetail {
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  return {
    kind: 'job_batch',
    id: b.id,
    status: b.status,
    batch_date: b.batch_date,
    counts: {
      companies_added: n(b.companies_added),
      companies_pulled: n(b.companies_pulled),
      companies_unresolved: n(b.companies_unresolved),
      contacts_total: n(b.contacts_total),
      contacts_kept: n(b.contacts_kept),
    },
    leadsfriday_order_id: b.leadsfriday_order_id === null ? null : Number(b.leadsfriday_order_id),
    leadsfriday_status: b.leadsfriday_status,
    error: b.error,
    gate: toOrderGate(gates),
  }
}
