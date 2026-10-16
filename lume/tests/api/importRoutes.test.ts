import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) } }),
}))

const ingest = vi.hoisted(() => ({ createIngest: vi.fn(), createApolloOrder: vi.fn() }))
vi.mock('@/lib/import/ingest', () => ingest)

const apify = vi.hoisted(() => ({ lastSucceededDatasetId: vi.fn(), datasetItems: vi.fn(), configured: true }))
vi.mock('@/lib/adapters/apify', async () => {
  class ApifyError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string
    ) {
      super(message)
    }
  }
  return {
    ApifyError,
    isApifyConfigured: () => apify.configured,
    lastSucceededDatasetId: (...a: unknown[]) => apify.lastSucceededDatasetId(...a),
    datasetItems: (...a: unknown[]) => apify.datasetItems(...a),
  }
})

const svc = vi.hoisted(() => ({
  getOrders: vi.fn(),
  getIngest: vi.fn(),
  getApolloOrder: vi.fn(),
  getJobBatch: vi.fn(),
  getJobSample: vi.fn(),
  getGatesForTargets: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...svc,
  isDbError: () => false,
}))
const storage = vi.hoisted(() => ({ readObjectHead: vi.fn() }))
vi.mock('@/lib/import/storage', () => ({
  ...storage,
  StorageError: class StorageError extends Error {},
}))

import { POST as apifyPOST } from '@/app/api/import/apify/route'
import { POST as csvPOST } from '@/app/api/import/csv/route'
import { POST as apolloPOST } from '@/app/api/import/apollo-link/route'
import { GET as ordersGET } from '@/app/api/orders/route'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'
const JOB = '2b1e6f0e-6c1d-4f43-9a6e-1f6f0c9f4a11'
const json = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const RESULT = { ingest: { id: ID }, rowCount: 2, detectedColumn: 'email', telegram: 'sent' }

beforeEach(() => {
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  for (const f of [...Object.values(ingest), ...Object.values(svc), storage.readObjectHead, apify.lastSucceededDatasetId, apify.datasetItems]) f.mockReset()
  apify.configured = true
  ingest.createIngest.mockResolvedValue(RESULT)
  svc.getGatesForTargets.mockResolvedValue([])
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/import/apify', () => {
  it.each([{}, { dataset_id: 'a', actor_id: 'b' }, { dataset_id: '' }, { dataset_id: '../x' }])('400 on %j', async (body) => {
    const res = await apifyPOST(json('/api/import/apify', body))
    expect(res.status).toBe(400)
    expect(ingest.createIngest).not.toHaveBeenCalled()
  })

  it('413 over the 1 KB body cap', async () => {
    const res = await apifyPOST(json('/api/import/apify', { dataset_id: 'a'.repeat(2000) }))
    expect(res.status).toBe(413)
  })

  it('503 when APIFY_API_TOKEN is unset', async () => {
    apify.configured = false
    const res = await apifyPOST(json('/api/import/apify', { dataset_id: 'abc' }))
    expect(res.status).toBe(503)
  })

  it('dataset_id → items → CSV (nested JSON) → createIngest', async () => {
    apify.datasetItems.mockResolvedValue({ items: [{ email: 'a@x.com', loc: { city: 'Austin' } }], truncated: false })
    const res = await apifyPOST(json('/api/import/apify', { dataset_id: 'hLx2Q8k1sTn5vCzE3' }))
    expect(res.status).toBe(200)
    expect(apify.lastSucceededDatasetId).not.toHaveBeenCalled()
    const [bytes, filename, meta] = ingest.createIngest.mock.calls[0]
    expect(new TextDecoder().decode(bytes)).toBe('email,loc\na@x.com,"{""city"":""Austin""}"\n')
    expect(filename).toBe('apify-hLx2Q8k1sTn5vCzE3.csv')
    expect(meta.source).toBe('apify')
    expect(await res.json()).toMatchObject({ ok: true, ingest_id: ID, gate: `ingest_approval:${ID}`, items: 1, truncated: false })
  })

  it('actor_id → last succeeded run dataset', async () => {
    apify.lastSucceededDatasetId.mockResolvedValue('DS1')
    apify.datasetItems.mockResolvedValue({ items: [{ email: 'a@x.com' }], truncated: true })
    const res = await apifyPOST(json('/api/import/apify', { actor_id: 'user~my-actor' }))
    expect(res.status).toBe(200)
    expect(apify.lastSucceededDatasetId).toHaveBeenCalledWith('user~my-actor')
    expect(apify.datasetItems).toHaveBeenCalledWith('DS1')
    expect((await res.json()).truncated).toBe(true)
  })

  it('404 when the actor has no succeeded run; 422 on an empty dataset', async () => {
    const { ApifyError } = await import('@/lib/adapters/apify')
    apify.lastSucceededDatasetId.mockRejectedValue(new ApifyError('no_succeeded_run', 404, 'none'))
    expect((await apifyPOST(json('/api/import/apify', { actor_id: 'x~y' }))).status).toBe(404)
    apify.datasetItems.mockResolvedValue({ items: [], truncated: false })
    expect((await apifyPOST(json('/api/import/apify', { dataset_id: 'abc' }))).status).toBe(422)
    expect(ingest.createIngest).not.toHaveBeenCalled()
  })
})

function multipart(file: File | null, extra?: Record<string, string>) {
  const form = new FormData()
  if (file) form.append('file', file)
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v)
  return new Request('http://localhost/api/import/csv', { method: 'POST', body: form })
}

describe('POST /api/import/csv', () => {
  it('415 for a non-multipart request', async () => {
    const res = await csvPOST(json('/api/import/csv', { file: 'x' }))
    expect(res.status).toBe(415)
  })

  it('415 for a non-.csv file name', async () => {
    const res = await csvPOST(multipart(new File(['email\na\n'], 'leads.xlsx')))
    expect(res.status).toBe(415)
    expect(ingest.createIngest).not.toHaveBeenCalled()
  })

  it('413 when the declared length is over 20 MB (before reading)', async () => {
    const req = new Request('http://localhost/api/import/csv', {
      method: 'POST',
      body: 'x',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(21 * 1024 * 1024) },
    })
    expect((await csvPOST(req)).status).toBe(413)
  })

  it('413 when the streamed body passes the cap', async () => {
    // No Content-Length: the cap is enforced while streaming.
    const chunk = new Uint8Array(1024 * 1024).fill(97)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ > 25) c.close()
        else c.enqueue(chunk)
      },
    })
    const req = new Request('http://localhost/api/import/csv', {
      method: 'POST',
      body,
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      duplex: 'half',
    } as RequestInit)
    expect((await csvPOST(req)).status).toBe(413)
    expect(sent).toBeLessThan(25)
  })

  it('400 for a missing file, a binary file, or a header-only file', async () => {
    expect((await csvPOST(multipart(null, { other: '1' }))).status).toBe(400)
    expect((await csvPOST(multipart(new File([new Uint8Array([80, 75, 3, 4, 0, 0])], 'x.csv')))).status).toBe(400)
    const headerOnly = await csvPOST(multipart(new File(['email\n'], 'x.csv')))
    expect(headerOnly.status).toBe(400)
    expect(await headerOnly.json()).toEqual({ error: 'empty_csv' })
  })

  it('a .csv upload → createIngest with its bytes and name', async () => {
    const res = await csvPOST(multipart(new File(['Name,Email\nA,a@x.com\n'], 'Leads Oct.CSV')))
    expect(res.status).toBe(200)
    const [bytes, filename, meta] = ingest.createIngest.mock.calls[0]
    expect(new TextDecoder().decode(bytes)).toBe('Name,Email\nA,a@x.com\n')
    expect(filename).toBe('Leads Oct.CSV')
    expect(meta).toEqual({ source: 'csv' })
    expect(await res.json()).toMatchObject({ ok: true, ingest_id: ID, row_count: 2, telegram: 'sent' })
  })
})

describe('POST /api/import/apollo-link', () => {
  it.each(['https://app.apollo.io/#/companies?x=1', 'not a url', 'http://app.apollo.io/#/people?x=1'])('400 on %s', async (url) => {
    const res = await apolloPOST(json('/api/import/apollo-link', { url }))
    expect(res.status).toBe(400)
    expect(ingest.createApolloOrder).not.toHaveBeenCalled()
  })

  it('creates the order awaiting its count', async () => {
    ingest.createApolloOrder.mockResolvedValue({ order: { id: ID, status: 'awaiting_count' }, telegram: 'skipped' })
    const url = 'https://app.apollo.io/#/people?page=1&personTitles[]=ceo'
    const res = await apolloPOST(json('/api/import/apollo-link', { url: ` ${url} ` }))
    expect(res.status).toBe(200)
    expect(ingest.createApolloOrder).toHaveBeenCalledWith(url)
    expect(await res.json()).toEqual({ ok: true, order_id: ID, status: 'awaiting_count', telegram: 'skipped', gate: `lfo_count:${ID}` })
  })
})

describe('GET /api/orders', () => {
  const get = (q: string) => ordersGET(new Request(`http://localhost/api/orders${q}`))

  it('list stays the default', async () => {
    svc.getOrders.mockResolvedValue([])
    expect((await get('?limit=5')).status).toBe(200)
    expect(svc.getOrders).toHaveBeenCalledWith({ limit: 5 })
  })

  it('400 on a bad id or kind', async () => {
    expect((await get('?id=nope&kind=ingest')).status).toBe(400)
    expect((await get(`?id=${ID}&kind=widget`)).status).toBe(400)
    expect((await get(`?id=${ID}`)).status).toBe(400)
  })

  it('ingest before approval: header + 5 rows from Storage', async () => {
    svc.getIngest.mockResolvedValue({ id: ID, storage_path: 'lume/x.csv', validation_job_id: null, status: 'awaiting_approval', sender_platform: 'lume', filename: 'x.csv', row_count: 7, detected_email_column: 'email' })
    storage.readObjectHead.mockResolvedValue({ text: 'email\n1\n2\n3\n4\n5\n6\n7\n', truncated: false })
    svc.getGatesForTargets.mockResolvedValue([{ kind: 'ingest_approval', target_id: ID }])
    const res = await get(`?id=${ID}&kind=ingest`)
    const body = await res.json()
    expect(storage.readObjectHead).toHaveBeenCalledWith('lume/x.csv')
    expect(body.sample).toEqual({ headers: ['email'], rows: [['1'], ['2'], ['3'], ['4'], ['5']] })
    expect(body.gate.param).toBe(`ingest_approval:${ID}`)
    expect(svc.getJobSample).not.toHaveBeenCalled()
  })

  it('ingest with a job: validation_rows sample, gates looked up on both ids', async () => {
    svc.getIngest.mockResolvedValue({ id: ID, storage_path: 'lume/x.csv', validation_job_id: JOB, status: 'approved', sender_platform: 'telegram', filename: 'x.csv', row_count: 1, detected_email_column: 'email' })
    svc.getJobSample.mockResolvedValue({ id: JOB, enrich: false, icp_filter: false, icp_description: null, column_order: ['email'], rows: [{ row_index: 0, row_data: { email: 'a@x.com' } }] })
    const body = await (await get(`?id=${ID}&kind=ingest`)).json()
    expect(svc.getGatesForTargets).toHaveBeenCalledWith([ID, JOB])
    expect(body.sample_from).toBe('job')
    expect(storage.readObjectHead).not.toHaveBeenCalled()
  })

  it('apollo_order and job_batch details; 404 when missing', async () => {
    svc.getApolloOrder.mockResolvedValue({ id: ID, status: 'awaiting_count', count_status: 'awaiting', contact_count: null, credits_deducted: null, new_balance: null, leadsfriday_order_id: null, ingest_id: null })
    expect((await (await get(`?id=${ID}&kind=apollo_order`)).json()).awaiting_count).toBe(true)
    svc.getJobBatch.mockResolvedValue(null)
    expect((await get(`?id=${ID}&kind=job_batch`)).status).toBe(404)
  })
})
