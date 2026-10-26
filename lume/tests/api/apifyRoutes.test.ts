import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({ storeShortlist: vi.fn(), loadActor: vi.fn(), briefView: vi.fn() }))
vi.mock('@/lib/apify/service', async (orig) => ({ ...(await orig<typeof import('@/lib/apify/service')>()), ...svc }))
const adapter = vi.hoisted(() => ({ getRun: vi.fn() }))
vi.mock('@/lib/adapters/apify', async (orig) => ({ ...(await orig<typeof import('@/lib/adapters/apify')>()), ...adapter }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getClaims: async () => ({ data: null }) } }) }))

import { GET as storeGET } from '@/app/api/apify/store/route'
import { GET as actorGET } from '@/app/api/apify/actor/route'
import { GET as runGET } from '@/app/api/apify/runs/[id]/route'
import { ApifyError } from '@/lib/adapters/apify'

const SECRET = 'internal-secret-for-tests-0123456789'
const req = (path: string, auth = true) =>
  new Request(`https://lume.test${path}`, auth ? { headers: { Authorization: `Bearer ${SECRET}` } } : {})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.LUME_INTERNAL_SECRET = SECRET
  process.env.APIFY_API_TOKEN = 'apify_test_token'
})

describe('/api/apify routes', () => {
  it('need the owner (session or internal bearer)', async () => {
    expect((await storeGET(req('/api/apify/store?q=x', false))).status).toBe(401)
  })

  it('store: q is required; returns the shortlist', async () => {
    expect((await storeGET(req('/api/apify/store'))).status).toBe(400)
    svc.storeShortlist.mockResolvedValue({ total: 1, actors: [{ id: 'a/b' }] })
    const res = await storeGET(req('/api/apify/store?q=google%20maps&limit=50'))
    expect(await res.json()).toEqual({ total: 1, actors: [{ id: 'a/b' }] })
    expect(svc.storeShortlist).toHaveBeenCalledWith('google maps', 20)
  })

  it('503 when Apify is not configured', async () => {
    delete process.env.APIFY_API_TOKEN
    expect((await storeGET(req('/api/apify/store?q=x'))).status).toBe(503)
  })

  it('actor: id must be username/name; unknown actor is 404', async () => {
    expect((await actorGET(req('/api/apify/actor?id=nope'))).status).toBe(400)
    svc.loadActor.mockRejectedValue(new ApifyError('not_found', 404, 'actor not found'))
    expect((await actorGET(req('/api/apify/actor?id=a/b'))).status).toBe(404)
  })

  it('runs: status, items and cost', async () => {
    adapter.getRun.mockResolvedValue({
      id: 'RUN12345', status: 'SUCCEEDED', statusMessage: null, startedAt: null, finishedAt: null, datasetId: 'DS1',
      usageTotalUsd: 3.2, options: { maxTotalChargeUsd: 20 }, chargedEventCounts: null, consoleUrl: 'u', itemCount: 812, actorId: 'A',
    })
    const res = await runGET(req('/api/apify/runs/RUN12345'), { params: Promise.resolve({ id: 'RUN12345' }) })
    expect(await res.json()).toMatchObject({ status: 'SUCCEEDED', item_count: 812, cost_usd: 3.2, dataset_id: 'DS1' })
    expect((await runGET(req('/api/apify/runs/x'), { params: Promise.resolve({ id: '../x' }) })).status).toBe(400)
  })
})
