import { describe, expect, it } from 'vitest'
import type { ApolloOrderRow, GateRow, JobBatchRow, JobSampleSource, TelegramIngestRow } from '@/lib/db/types'
import { apolloOrderDetail, dashboardJobDetail, ingestDetail, jobBatchDetail, jobSample, toOrderGate } from '@/lib/import/orderDetail'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'
const JOB = '2b1e6f0e-6c1d-4f43-9a6e-1f6f0c9f4a11'
const T = '2026-10-15T10:00:00Z'

const ingest = (over: Partial<TelegramIngestRow> = {}): TelegramIngestRow => ({
  id: ID,
  telegram_chat_id: '1',
  telegram_message_id: null,
  sender_chat_id: '1',
  sender_name: 'Lume',
  sender_platform: 'lume',
  filename: 'apify-x.csv',
  storage_path: 'lume/x.csv',
  row_count: 2,
  detected_email_column: 'email',
  status: 'awaiting_approval',
  validation_job_id: null,
  created_at: T,
  ...over,
})
const gate = (kind: GateRow['kind'], target_id: string): GateRow => ({
  kind,
  target_table: 'telegram_ingests',
  target_id,
  title: null,
  subtitle: null,
  actions: [],
  counts: {},
  telegram_message_id: null,
  created_at: T,
})
const job = (over: Partial<JobSampleSource> = {}): JobSampleSource => ({
  id: JOB,
  filename: 'f.csv',
  status: 'processing',
  total_rows: 10,
  enrich: true,
  icp_filter: true,
  icp_description: 'B2B SaaS founders',
  column_order: ['email', 'name'],
  rows: [
    { row_index: 0, row_data: { email: 'a@x.com', name: 'A', extra: 'hidden' } },
    { row_index: 1, row_data: { email: 'b@x.com', name: { first: 'B' } } },
  ],
  ...over,
})

describe('orders detail mapping', () => {
  it('toOrderGate: first open gate → Validate param; none → null', () => {
    expect(toOrderGate([gate('ingest_approval', ID)])).toEqual({ kind: 'ingest_approval', target_id: ID, param: `ingest_approval:${ID}` })
    expect(toOrderGate([])).toBeNull()
  })

  it('ingest before approval: file sample, no enrichment, the approval gate', () => {
    const d = ingestDetail(ingest(), {
      fileSample: { headers: ['email'], rows: [['a@x.com']] },
      job: null,
      gates: [gate('ingest_approval', ID)],
    })
    expect(d).toMatchObject({
      kind: 'ingest',
      status: 'awaiting_approval',
      email_column: 'email',
      sample_from: 'file',
      sample: { headers: ['email'], rows: [['a@x.com']] },
      enrichment: null,
      gate: { param: `ingest_approval:${ID}` },
    })
  })

  it('ingest with a validation job: job rows (column_order) + read-only enrichment', () => {
    const d = ingestDetail(ingest({ status: 'approved', validation_job_id: JOB }), { fileSample: null, job: job(), gates: [] })
    expect(d).toMatchObject({
      kind: 'ingest',
      sample_from: 'job',
      sample: { headers: ['email', 'name'], rows: [['a@x.com', 'A'], ['b@x.com', '{"first":"B"}']] },
      enrichment: { enrich: true, icp_filter: true, icp_description: 'B2B SaaS founders' },
      gate: null,
    })
  })

  it('jobSample falls back to first-seen keys without column_order; no rows → null', () => {
    expect(jobSample({ column_order: null, rows: [{ row_index: 0, row_data: { b: 1, a: 2 } }] })).toEqual({ headers: ['b', 'a'], rows: [['1', '2']] })
    expect(jobSample({ column_order: ['a'], rows: [] })).toBeNull()
  })

  it('dashboard_job: job sample + config', () => {
    const d = dashboardJobDetail(job({ enrich: null, icp_filter: false, icp_description: null }), [gate('finder_decision', JOB)])
    expect(d).toMatchObject({
      kind: 'dashboard_job',
      row_count: 10,
      enrichment: { enrich: false, icp_filter: false, icp_description: null },
      gate: { param: `finder_decision:${JOB}` },
    })
  })

  it('apollo_order: status, count, credits, Leadsfriday ids; awaiting_count only while unclaimed', () => {
    const o: ApolloOrderRow = {
      id: ID,
      apollo_url: 'https://app.apollo.io/#/people?x=1',
      contact_count: 1000,
      status: 'delivered',
      count_status: 'claimed',
      leadsfriday_order_id: 4242,
      leadsfriday_status: 'delivered',
      credits_deducted: '1000' as unknown as number,
      new_balance: 9000,
      ingest_id: null,
      telegram_message_id: 5,
      error: null,
      created_at: T,
    }
    expect(apolloOrderDetail(o, [])).toMatchObject({
      kind: 'apollo_order',
      contact_count: 1000,
      credits_deducted: 1000,
      new_balance: 9000,
      leadsfriday_order_id: 4242,
      awaiting_count: false,
    })
    expect(apolloOrderDetail({ ...o, status: 'awaiting_count', count_status: 'awaiting' }, [gate('lfo_count', ID)])).toMatchObject({
      awaiting_count: true,
      gate: { param: `lfo_count:${ID}` },
    })
    expect(apolloOrderDetail({ ...o, status: 'awaiting_count', count_status: 'claimed' }, [])).toMatchObject({ awaiting_count: false })
  })

  it('job_batch: counts', () => {
    const b: JobBatchRow = {
      id: ID,
      batch_date: '2026-10-12',
      status: 'awaiting_review',
      companies_added: 40,
      companies_pulled: 31,
      companies_unresolved: 2,
      contacts_total: 0,
      contacts_kept: 0,
      leadsfriday_order_id: null,
      leadsfriday_status: null,
      error: null,
      created_at: T,
    }
    expect(jobBatchDetail(b, [gate('jobs_review', ID)])).toMatchObject({
      kind: 'job_batch',
      batch_date: '2026-10-12',
      counts: { companies_added: 40, companies_pulled: 31, companies_unresolved: 2, contacts_total: 0, contacts_kept: 0 },
      gate: { param: `jobs_review:${ID}` },
    })
  })
})
