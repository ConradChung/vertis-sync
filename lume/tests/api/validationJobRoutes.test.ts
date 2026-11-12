import { beforeEach, describe, expect, it, vi } from 'vitest'

// Owner gate passes; the route logic is under test.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))

const store = vi.hoisted(() => ({
  getPreviewPage: vi.fn(),
  getPreviewJob: vi.fn(),
  renameJob: vi.fn(),
  listValidatedJobs: vi.fn(),
  previewCsvChunks: vi.fn(),
  displayNamesFor: vi.fn(),
}))
vi.mock('@/lib/validate/previewStore', () => Object.fromEntries(Object.keys(store).map((k) => [k, (...a: unknown[]) => store[k as keyof typeof store](...a)])))

import { PATCH } from '@/app/api/validation-jobs/[id]/route'
import { GET as rowsGET } from '@/app/api/validation-jobs/[id]/rows/route'
import { GET as listGET } from '@/app/api/validation-jobs/route'
import { GET as exportGET } from '@/app/api/validation-jobs/[id]/export/route'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const patch = (body: unknown) => new Request(`http://localhost/api/validation-jobs/${JOB}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const get = (url: string) => new Request(`http://localhost${url}`)

beforeEach(() => {
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  for (const f of Object.values(store)) f.mockReset()
})

describe('PATCH /api/validation-jobs/[id]', () => {
  it('saves a trimmed name', async () => {
    store.renameJob.mockResolvedValue({ id: JOB, name: 'UK agents' })
    const res = await PATCH(patch({ display_name: '  UK agents ' }), params(JOB))
    expect(res.status).toBe(200)
    expect(store.renameJob).toHaveBeenCalledWith(JOB, 'UK agents')
  })

  it('an empty name resets to the filename (null)', async () => {
    store.renameJob.mockResolvedValue({ id: JOB })
    await PATCH(patch({ display_name: '' }), params(JOB))
    expect(store.renameJob).toHaveBeenCalledWith(JOB, null)
  })

  it('400 on a long name, a bad id or extra keys; 404 when the job is gone', async () => {
    expect((await PATCH(patch({ display_name: 'x'.repeat(121) }), params(JOB))).status).toBe(400)
    expect((await PATCH(patch({ display_name: 'a', status: 'done' }), params(JOB))).status).toBe(400)
    expect((await PATCH(patch({ display_name: 'a' }), params('nope'))).status).toBe(400)
    expect(store.renameJob).not.toHaveBeenCalled()
    store.renameJob.mockResolvedValue(null)
    expect((await PATCH(patch({ display_name: 'a' }), params(JOB))).status).toBe(404)
  })
})

describe('GET /api/validation-jobs/[id]/rows', () => {
  it('passes page, status and the cleaned search to the store', async () => {
    store.getPreviewPage.mockResolvedValue({ rows: [], total: 0 })
    const res = await rowsGET(get(`/api/validation-jobs/${JOB}/rows?page=3&status=invalid&q=%22acme%22`), params(JOB))
    expect(res.status).toBe(200)
    expect(store.getPreviewPage).toHaveBeenCalledWith(JOB, { page: 3, status: 'invalid', q: 'acme', send: 'all' })
  })

  it('400 on bad page / status, 404 on a missing job', async () => {
    expect((await rowsGET(get(`/api/validation-jobs/${JOB}/rows?page=x`), params(JOB))).status).toBe(400)
    expect((await rowsGET(get(`/api/validation-jobs/${JOB}/rows?status=pending`), params(JOB))).status).toBe(400)
    store.getPreviewPage.mockResolvedValue(null)
    expect((await rowsGET(get(`/api/validation-jobs/${JOB}/rows`), params(JOB))).status).toBe(404)
  })
})

describe('GET /api/validation-jobs', () => {
  it('lists a campaign’s lists plus unassigned ones', async () => {
    store.listValidatedJobs.mockResolvedValue([{ id: JOB }])
    const res = await listGET(get('/api/validation-jobs?campaign_id=bcf7a6d2-1302-47fc-ae77-9d2a760c91c1&unassigned=1'))
    expect(await res.json()).toEqual({ jobs: [{ id: JOB }] })
    expect(store.listValidatedJobs).toHaveBeenCalledWith({ campaignId: 'bcf7a6d2-1302-47fc-ae77-9d2a760c91c1', unassigned: true })
  })

  it('refuses odd campaign ids; nothing asked → empty', async () => {
    expect((await listGET(get('/api/validation-jobs?campaign_id=a,b'))).status).toBe(400)
    expect(await (await listGET(get('/api/validation-jobs'))).json()).toEqual({ jobs: [] })
    expect(store.listValidatedJobs).not.toHaveBeenCalled()
  })
})

describe('GET /api/validation-jobs/[id]/export', () => {
  it('streams the CSV with a file name from the job name', async () => {
    store.getPreviewJob.mockResolvedValue({ id: JOB, name: 'UK agents' })
    store.previewCsvChunks.mockImplementation(async function* () {
      yield 'Email,Status\n'
      yield 'a@b.com,Valid\n'
    })
    const res = await exportGET(get(`/api/validation-jobs/${JOB}/export?status=valid`), params(JOB))
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="UK-agents-valid.csv"')
    expect(await res.text()).toBe('Email,Status\na@b.com,Valid\n')
    expect((await exportGET(get(`/api/validation-jobs/${JOB}/export?status=invalid`), params(JOB))).status).toBe(400)
  })
})
