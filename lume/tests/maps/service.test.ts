import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))
const m = vi.hoisted(() => ({ loadActor: vi.fn(), buildActionRequest: vi.fn(), createAction: vi.fn() }))
vi.mock('@/lib/apify/service', () => ({ loadActor: m.loadActor }))
vi.mock('@/lib/actions/build', () => ({ buildActionRequest: m.buildActionRequest }))
vi.mock('@/lib/actions/create', () => ({ createAction: m.createAction }))

import { ApifyError } from '@/lib/adapters/apify'
import { fileMapsScrape, MapsError, planMapsScrape } from '@/lib/maps/service'
import { LA_COUNTY_AREAS } from '@/lib/maps/areas'

const SCHEMA = { properties: Object.fromEntries(['searchStringsArray', 'maxCrawledPlacesPerSearch', 'language', 'skipClosedPlaces', 'scrapeContacts', 'scrapePlaceDetailPage', 'maxReviews', 'maxImages'].map((k) => [k, {}])) }

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.loadActor.mockResolvedValue({ schema: SCHEMA })
  m.buildActionRequest.mockImplementation(async ({ kind, payload }) => ({ ok: true, kind, payload: { ...payload, summary: 'Run compass/crawler-google-places · up to $20' } }))
  m.createAction.mockImplementation(async (kind, payload, by) => ({ id: 'A1', kind, payload, requested_by: by }))
})

describe('planMapsScrape', () => {
  it('fits the request to the live schema and starts nothing', async () => {
    const plan = await planMapsScrape({ regions: ['westside'] })
    expect(plan.dropped_fields).toEqual(['maxQuestions'])
    expect(plan.request.input).not.toHaveProperty('maxQuestions')
    expect(plan.areas.every((a) => a.region === 'westside')).toBe(true)
    expect(m.createAction).not.toHaveBeenCalled()
  })
  it('bad options → 400; Apify not connected → 503', async () => {
    await expect(planMapsScrape({ areas: ['atlantis'] })).rejects.toMatchObject({ status: 400, code: 'unknown_area: atlantis' })
    m.loadActor.mockRejectedValueOnce(new ApifyError('not_configured', 503, 'x'))
    await expect(planMapsScrape({})).rejects.toBeInstanceOf(MapsError)
  })
})

describe('fileMapsScrape', () => {
  it('files one run_actor pending action (the run waits for Confirm), tagged with the lane', async () => {
    const out = await fileMapsScrape({}, 'user')
    expect(m.buildActionRequest).toHaveBeenCalledWith({ kind: 'run_actor', payload: expect.objectContaining({ actor_id: 'compass/crawler-google-places', max_charge_usd: 20 }) })
    const [kind, payload, by] = m.createAction.mock.calls[0]
    expect(kind).toBe('run_actor')
    expect(by).toBe('user')
    expect(payload).toMatchObject({ lane: 'gtm-12-google-maps', areas_count: LA_COUNTY_AREAS.length })
    expect(out.action.id).toBe('A1')
  })
  it('a run_actor refusal comes back as MapsError and files nothing', async () => {
    m.buildActionRequest.mockResolvedValueOnce({ ok: false, status: 422, error: 'invalid_input' })
    await expect(fileMapsScrape({}, 'agent')).rejects.toMatchObject({ status: 422, code: 'invalid_input' })
    expect(m.createAction).not.toHaveBeenCalled()
  })
})
