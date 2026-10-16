import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) } }),
}))

const ingest = vi.hoisted(() => ({ createIngest: vi.fn(), createApolloOrder: vi.fn(), createIngestForStoredObject: vi.fn() }))
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
  findIngestByStoragePath: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...svc,
  isDbError: () => false,
}))
const storage = vi.hoisted(() => ({ readObjectHead: vi.fn(), statObject: vi.fn(), scanObject: vi.fn(), createSignedUpload: vi.fn() }))
vi.mock('@/lib/import/storage', () => ({
  ...storage,
  StorageError: class StorageError extends Error {},
}))

import { POST as apifyPOST } from '@/app/api/import/apify/route'
import { POST as csvPOST } from '@/app/api/import/csv/route'
import { POST as signPOST } from '@/app/api/import/csv/sign/route'
import { uploadTicket } from '@/lib/import/ticket'
import { POST as apolloPOST } from '@/app/api/import/apollo-link/route'
import { GET as ordersGET } from '@/app/api/orders/route'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'
const JOB = '2b1e6f0e-6c1d-4f43-9a6e-1f6f0c9f4a11'
const json = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const RESULT = { ingest: { id: ID }, rowCount: 2, detectedColumn: 'email', telegram: 'sent' }

beforeEach(() => {
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  process.env.LUME_INTERNAL_SECRET = 'test-internal-secret'
  for (const f of [...Object.values(ingest), ...Object.values(svc), ...Object.values(storage), apify.lastSucceededDatasetId, apify.datasetItems]) f.mockReset()
  apify.configured = true
  ingest.createIngest.mockResolvedValue(RESULT)
  ingest.createIngestForStoredObject.mockResolvedValue(RESULT)
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
    apify.datasetItems.mockResolvedValue({ items: [{ email: 'a@x.com', loc: { city: 'Austin' } }], truncated: false, skipped: 2 })
    const res = await apifyPOST(json('/api/import/apify', { dataset_id: 'hLx2Q8k1sTn5vCzE3' }))
    expect(res.status).toBe(200)
    expect(apify.lastSucceededDatasetId).not.toHaveBeenCalled()
    const [bytes, filename, meta] = ingest.createIngest.mock.calls[0]
    expect(new TextDecoder().decode(bytes)).toBe('email,loc\na@x.com,"{""city"":""Austin""}"\n')
    expect(filename).toBe('apify-hLx2Q8k1sTn5vCzE3.csv')
    expect(meta.source).toBe('apify')
    expect(await res.json()).toMatchObject({ ok: true, ingest_id: ID, gate: `ingest_approval:${ID}`, items: 1, truncated: false, skipped: 2 })
  })

  it('actor_id → last succeeded run dataset', async () => {
    apify.lastSucceededDatasetId.mockResolvedValue('DS1')
    apify.datasetItems.mockResolvedValue({ items: [{ email: 'a@x.com' }], truncated: true })
    const res = await apifyPOST(json('/api/import/apify', { actor_id: 'user~my-actor' }))
    expect(res.status).toBe(200)
    expect(apify.lastSucceededDatasetId).toHaveBeenCalledWith('user~my-actor', expect.any(AbortSignal))
    expect(apify.datasetItems).toHaveBeenCalledWith('DS1', expect.any(AbortSignal))
    // The same deadline covers the upload.
    expect(ingest.createIngest.mock.calls[0][2].signal).toBe(apify.datasetItems.mock.calls[0][1])
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

  it('504 apify_timeout when the shared deadline passes; 413 when the items body is too large', async () => {
    const { ApifyError } = await import('@/lib/adapters/apify')
    apify.datasetItems.mockRejectedValueOnce(new ApifyError('timeout', 504, 'slow'))
    const t = await apifyPOST(json('/api/import/apify', { dataset_id: 'abc' }))
    expect(t.status).toBe(504)
    expect(await t.json()).toEqual({ error: 'apify_timeout' })
    apify.datasetItems.mockRejectedValueOnce(new ApifyError('too_large', 413, 'big'))
    expect((await apifyPOST(json('/api/import/apify', { dataset_id: 'abc' }))).status).toBe(413)
  })
})

const PATH = 'lume/0b6f6c1e-8a51-4c43-9d0e-6e7a1f3b2c4d.csv'
const enc = (t: string) => new TextEncoder().encode(t)

describe('POST /api/import/csv/sign', () => {
  it('signs a lume/<uuid>.csv path with a verifiable ticket', async () => {
    storage.createSignedUpload.mockImplementation(async (path: string) => ({ path, token: 'tok', signedUrl: `https://s/${path}?token=tok` }))
    const res = await signPOST(json('/api/import/csv/sign', { filename: 'Leads.CSV', size: 1234 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path).toMatch(/^lume\/[0-9a-f-]{36}\.csv$/)
    expect(body.token).toBe('tok')
    expect(body.upload_ticket).toBe(uploadTicket(body.path))
    expect(storage.createSignedUpload).toHaveBeenCalledWith(body.path)
  })

  it('415 for a non-.csv name, 413 over 20 MB, 400 on a bad body — nothing signed', async () => {
    expect((await signPOST(json('/api/import/csv/sign', { filename: 'a.xlsx', size: 10 }))).status).toBe(415)
    expect((await signPOST(json('/api/import/csv/sign', { filename: 'a.csv', size: 20 * 1024 * 1024 + 1 }))).status).toBe(413)
    expect((await signPOST(json('/api/import/csv/sign', { filename: 'a.csv', size: 0 }))).status).toBe(400)
    expect((await signPOST(json('/api/import/csv/sign', { filename: 'a.csv' }))).status).toBe(400)
    expect(storage.createSignedUpload).not.toHaveBeenCalled()
  })
})

describe('POST /api/import/csv (stored object)', () => {
  const submit = (over: Record<string, unknown> = {}) =>
    csvPOST(json('/api/import/csv', { storage_path: PATH, filename: 'leads.csv', upload_ticket: uploadTicket(PATH), ...over }))
  const scan = (text: string, rows: number) => ({ head: enc(text), rows, bytes: text.length })

  it('a verified upload → createIngestForStoredObject(path, name, header bytes, streamed row count)', async () => {
    svc.findIngestByStoragePath.mockResolvedValue(null)
    storage.statObject.mockResolvedValue({ size: 100 })
    storage.scanObject.mockResolvedValue(scan('Name,Email\nA,a@x.com\n', 1))
    const res = await submit()
    expect(res.status).toBe(200)
    const [path, filename, head, rows, meta] = ingest.createIngestForStoredObject.mock.calls[0]
    expect(path).toBe(PATH)
    expect(filename).toBe('leads.csv')
    expect(new TextDecoder().decode(head)).toBe('Name,Email\nA,a@x.com\n')
    expect(rows).toBe(1)
    expect(meta).toEqual({ source: 'csv' })
    expect(await res.json()).toMatchObject({ ok: true, ingest_id: ID, gate: `ingest_approval:${ID}` })
  })

  it.each(['telegram/0b6f6c1e-8a51-4c43-9d0e-6e7a1f3b2c4d.csv', 'lume/../telegram/x.csv', 'lume/abc.csv', `${PATH}.exe`])(
    '400 on path %s',
    async (p) => {
      const res = await submit({ storage_path: p, upload_ticket: uploadTicket(p) })
      expect(res.status).toBe(400)
      expect(storage.statObject).not.toHaveBeenCalled()
    }
  )

  it('403 when the ticket does not match the path', async () => {
    const other = 'lume/11111111-2222-4333-8444-555555555555.csv'
    expect((await submit({ upload_ticket: uploadTicket(other) })).status).toBe(403)
    expect((await submit({ upload_ticket: 'f'.repeat(64) })).status).toBe(403)
    expect((await submit({ upload_ticket: 'nothex' })).status).toBe(403)
    expect(svc.findIngestByStoragePath).not.toHaveBeenCalled()
  })

  it('409 when an ingest already points at the object', async () => {
    svc.findIngestByStoragePath.mockResolvedValue({ id: ID })
    const res = await submit()
    expect(res.status).toBe(409)
    expect(storage.statObject).not.toHaveBeenCalled()
    expect(ingest.createIngestForStoredObject).not.toHaveBeenCalled()
  })

  it('404 when the upload is missing; 413 when the object is over 20 MB (HEAD or streamed)', async () => {
    svc.findIngestByStoragePath.mockResolvedValue(null)
    storage.statObject.mockResolvedValueOnce(null)
    expect((await submit()).status).toBe(404)
    storage.statObject.mockResolvedValueOnce({ size: 20 * 1024 * 1024 + 1 })
    expect((await submit()).status).toBe(413)
    expect(storage.scanObject).not.toHaveBeenCalled()
    storage.statObject.mockResolvedValueOnce({ size: 10 })
    storage.scanObject.mockResolvedValueOnce(null)
    expect((await submit()).status).toBe(413)
    expect(ingest.createIngestForStoredObject).not.toHaveBeenCalled()
  })

  it('400 when the object is not CSV or has no rows; 415 for a non-.csv name', async () => {
    svc.findIngestByStoragePath.mockResolvedValue(null)
    storage.statObject.mockResolvedValue({ size: 10 })
    storage.scanObject.mockResolvedValueOnce({ head: new Uint8Array([80, 75, 3, 4, 0, 0]), rows: 3, bytes: 6 })
    expect(await (await submit()).json()).toEqual({ error: 'not_csv' })
    storage.scanObject.mockResolvedValueOnce(scan('email\n', 0))
    expect(await (await submit()).json()).toEqual({ error: 'empty_csv' })
    expect((await submit({ filename: 'x.txt' })).status).toBe(415)
    expect(ingest.createIngestForStoredObject).not.toHaveBeenCalled()
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
