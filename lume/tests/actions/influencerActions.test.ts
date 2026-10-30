import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InfluencerRow } from '@/lib/influencers/model'

const store = vi.hoisted(() => ({
  getInfluencersBySlugs: vi.fn(),
  getInfluencersByIds: vi.fn(),
  activeRun: vi.fn(),
  getRun: vi.fn(),
}))
vi.mock('@/lib/influencers/store', () => store)
const fn = vi.hoisted(() => ({ callInfluencerFn: vi.fn() }))
vi.mock('@/lib/adapters/influencerFn', () => fn)

import { buildInfluencerReactions, buildInfluencerRun, executeInfluencerReactions, executeInfluencerRun } from '@/lib/influencers/actions'
import { influencerPayloadError, INFLUENCER_PIPELINE } from '@/lib/influencers/actionPayload'

const P = '11111111-1111-4111-8111-111111111111'
const D = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
const ACTION = '44444444-4444-4444-8444-444444444444'

const inf = (o: Partial<InfluencerRow>): InfluencerRow => ({
  id: P, name: 'Peter Lohmann', slug: 'peter-lohmann', linkedin_url: 'https://www.linkedin.com/in/pslohmann', lookback_days: 90,
  max_reactions_per_post: 1000, active: true, notes: null, last_ran_at: '2026-10-07T12:00:00Z', last_posts: 317, last_top_posts: 10,
  last_reactions: 1114, last_reactors: 837, last_leads: 71, last_leads_700: 26, last_apify_usd: 2.31, last_perplexity_usd: 0.81,
  last_haiku_usd: 0.39, last_cost_usd: 3.51, ...o,
})
const peter = inf({})
const deb = inf({ id: D, name: 'Deb Newell', slug: 'deb-newell', last_posts: 42, last_reactions: 444, last_reactors: 295, last_leads: 25, last_leads_700: 9 })

const awaiting = {
  id: RUN, status: 'awaiting_approval', stage: 'reactions', influencer_ids: [P, D], start_action_id: ACTION, max_verify_usd: '10.00',
  reactions_estimate: [
    { influencer_id: P, slug: 'peter-lohmann', name: 'Peter Lohmann', posts: 10, reactions: 1114, usd: 1.67 },
    { influencer_id: D, slug: 'deb-newell', name: 'Deb Newell', posts: 10, reactions: 444, usd: 0.67 },
  ],
  reactions_estimate_usd: '2.3400',
}

beforeEach(() => {
  vi.resetAllMocks()
  store.activeRun.mockResolvedValue(null)
})

describe('buildInfluencerRun (approval 1)', () => {
  it('prices the posts scrape from last run and says it stops for the reactions bill', async () => {
    store.getInfluencersBySlugs.mockResolvedValue([deb, peter])
    const b = await buildInfluencerRun({ slugs: ['peter-lohmann', 'deb-newell'], max_verify_usd: 5 })
    if (!b.ok) throw new Error(b.error)
    expect(b.kind).toBe('influencer_run')
    expect(b.payload).toMatchObject({
      pipeline: INFLUENCER_PIPELINE, influencer_ids: [P, D], slugs: ['peter-lohmann', 'deb-newell'], max_verify_usd: 5,
      posts_usd: 0.72, posts_reserve_usd: 1.29,
    })
    expect(b.payload.summary).toMatch(/2 influencers \(Peter Lohmann, Deb Newell\)/)
    expect(b.payload.summary).toMatch(/posts scrape now: ~\$0\.72 \(Apify charge capped at \$1\.29\)/)
    expect(b.payload.summary).toMatch(/stops after top posts with the exact reactions bill/)
    expect(b.payload.summary).toMatch(/capped at \$5\.00/)
    expect(influencerPayloadError('influencer_run', b.payload)).toBeNull()
  })
  it('refuses unknown or inactive influencers, and a second run while one is active', async () => {
    store.getInfluencersBySlugs.mockResolvedValue([peter])
    expect(await buildInfluencerRun({ slugs: ['peter-lohmann', 'nobody'] })).toMatchObject({ ok: false, status: 404, error: 'unknown_influencers: nobody' })
    store.getInfluencersBySlugs.mockResolvedValue([inf({ active: false })])
    expect(await buildInfluencerRun({ slugs: ['peter-lohmann'] })).toMatchObject({ ok: false, status: 409 })
    store.getInfluencersBySlugs.mockResolvedValue([peter])
    store.activeRun.mockResolvedValue({ id: RUN, status: 'running' })
    expect(await buildInfluencerRun({ slugs: ['peter-lohmann'] })).toMatchObject({ ok: false, status: 409, error: 'run_in_progress' })
    expect(await buildInfluencerRun({ slugs: ['Peter'] })).toMatchObject({ ok: false, status: 400 })
  })
})

describe('buildInfluencerReactions (approval 2)', () => {
  it('shows the exact bill per influencer and the Apify cap', async () => {
    store.getRun.mockResolvedValue(awaiting)
    const b = await buildInfluencerReactions({ run_id: RUN.toUpperCase() })
    if (!b.ok) throw new Error(b.error)
    expect(b.payload).toMatchObject({ run_id: RUN, reactions: 1558, reactions_usd: 2.34, max_charge_usd: 2.68, max_verify_usd: 10 })
    expect(b.payload.summary).toMatch(/exactly 1,558 reactions on 20 top posts = \$2\.34 \(Apify charge capped at \$2\.68\)/)
    expect(b.payload.summary).toMatch(/Peter Lohmann 1114 \(\$1\.67\); Deb Newell 444 \(\$0\.67\)/)
    expect(influencerPayloadError('influencer_reactions', b.payload)).toBeNull()
  })
  it('refuses a run that is not waiting for this approval', async () => {
    store.getRun.mockResolvedValue({ ...awaiting, status: 'running', stage: 'verify' })
    expect(await buildInfluencerReactions({ run_id: RUN })).toMatchObject({ ok: false, status: 409 })
    store.getRun.mockResolvedValue(null)
    expect(await buildInfluencerReactions({ run_id: RUN })).toMatchObject({ ok: false, status: 404 })
  })
})

describe('executeInfluencerRun re-checks before starting', () => {
  const payload = { pipeline: INFLUENCER_PIPELINE, influencer_ids: [P, D], max_verify_usd: 5, posts_usd: 0.72, summary: 's' }
  it('starts the edge function with the approval id (idempotent start)', async () => {
    store.getInfluencersByIds.mockResolvedValue([peter, deb])
    fn.callInfluencerFn.mockResolvedValue({ ok: true, status: 202, body: { ok: true, run_id: RUN, status: 'running' } })
    expect(await executeInfluencerRun(payload, ACTION)).toEqual({ ok: true, result: { run_id: RUN, status: 'running', stage: 'posts' } })
    expect(fn.callInfluencerFn.mock.calls[0][0]).toMatchObject({ action: 'start', influencer_ids: [P, D], max_verify_usd: 5, start_action_id: ACTION })
  })
  it('fails when an influencer was deactivated or another run became active; nothing is called', async () => {
    store.getInfluencersByIds.mockResolvedValue([peter, { ...deb, active: false }])
    expect(await executeInfluencerRun(payload, ACTION)).toMatchObject({ ok: false, result: { influencer_ids: [D] } })
    store.getInfluencersByIds.mockResolvedValue([peter, deb])
    store.activeRun.mockResolvedValue({ id: 'other', status: 'running', start_action_id: 'someone-else' })
    expect(await executeInfluencerRun(payload, ACTION)).toMatchObject({ ok: false, error: 'another influencer run is active' })
    expect(fn.callInfluencerFn).not.toHaveBeenCalled()
  })
  it('a function refusal is a failure', async () => {
    store.getInfluencersByIds.mockResolvedValue([peter, deb])
    fn.callInfluencerFn.mockResolvedValue({ ok: false, status: 409, error: 'run_in_progress' })
    expect(await executeInfluencerRun(payload, ACTION)).toMatchObject({ ok: false, error: 'influencer-reactions start: run_in_progress' })
  })
})

describe('executeInfluencerReactions re-checks the bill', () => {
  const payload = { run_id: RUN, reactions_usd: 2.34, max_verify_usd: 10, summary: 's' }
  it('approves exactly the confirmed amount', async () => {
    store.getRun.mockResolvedValue(awaiting)
    fn.callInfluencerFn.mockResolvedValue({ ok: true, status: 202, body: { ok: true } })
    expect(await executeInfluencerReactions(payload, ACTION)).toMatchObject({ ok: true, result: { approved_usd: 2.34 } })
    expect(fn.callInfluencerFn.mock.calls[0][0]).toEqual({ action: 'approve_reactions', run_id: RUN, approved_usd: 2.34, reactions_action_id: ACTION, max_verify_usd: 10 })
  })
  it('refuses when the bill changed or the run moved on', async () => {
    store.getRun.mockResolvedValue({ ...awaiting, reactions_estimate_usd: '2.5' })
    expect(await executeInfluencerReactions(payload, ACTION)).toMatchObject({ ok: false, error: 'the reactions bill changed since approval' })
    store.getRun.mockResolvedValue({ ...awaiting, status: 'cancelled' })
    expect(await executeInfluencerReactions(payload, ACTION)).toMatchObject({ ok: false })
    expect(fn.callInfluencerFn).not.toHaveBeenCalled()
  })
})

describe('influencerPayloadError (createAction)', () => {
  it('refuses snapshots the executor could not run', () => {
    expect(influencerPayloadError('influencer_run', { pipeline: 'x', influencer_ids: [P], max_verify_usd: 5 })).toMatch(/pipeline/)
    expect(influencerPayloadError('influencer_run', { pipeline: INFLUENCER_PIPELINE, influencer_ids: ['ABCDEF00-1111-4111-8111-111111111111'], max_verify_usd: 5 })).toMatch(/lowercase/)
    expect(influencerPayloadError('influencer_run', { pipeline: INFLUENCER_PIPELINE, influencer_ids: [P], max_verify_usd: 51 })).toMatch(/max_verify/)
    expect(influencerPayloadError('influencer_reactions', { run_id: RUN, max_verify_usd: 5 })).toMatch(/reactions_usd/)
    expect(influencerPayloadError('influencer_reactions', { run_id: RUN, reactions_usd: 1, max_verify_usd: 5 })).toBeNull()
  })
})
