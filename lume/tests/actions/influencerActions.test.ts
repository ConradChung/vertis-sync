import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InfluencerRow } from '@/lib/influencers/model'

const store = vi.hoisted(() => ({
  getInfluencersBySlugs: vi.fn(),
  getInfluencersByIds: vi.fn(),
  activeRun: vi.fn(),
  getRun: vi.fn(),
  apifyMonthSpend: vi.fn(),
}))
vi.mock('@/lib/influencers/store', () => store)
vi.mock('@/lib/settings/store', () => ({ getApifyCapUsd: async () => 29 }))
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
  store.apifyMonthSpend.mockResolvedValue(20.5)
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
    expect(b.payload.summary).toMatch(/Shared Apify cap: \$8\.50 of \$29 left this month/)
    expect(b.payload.apify_cap_left_usd).toBe(8.5)
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

describe('buildInfluencerRun in URL mode (chosen posts)', () => {
  const U1 = 'https://www.linkedin.com/posts/pslohmann_pm-activity-7250000000000000000-AbCd'
  const U2 = 'https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000001'
  it('bills max_reactions_per_post per post, carries the normalized URLs and says so', async () => {
    store.getInfluencersBySlugs.mockResolvedValue([peter])
    const b = await buildInfluencerRun({ slugs: ['peter-lohmann'], max_verify_usd: 2, post_urls: [`${U1}/?utm_source=share#x`] })
    if (!b.ok) throw new Error(b.error)
    expect(b.kind).toBe('influencer_run')
    expect(b.payload).toMatchObject({
      pipeline: INFLUENCER_PIPELINE, influencer_ids: [P], slugs: ['peter-lohmann'], post_urls: [U1], max_verify_usd: 2,
      posts_usd: 0, reactions_max: 1000, reactions_usd: 2, reactions_max_charge_usd: 2.25, one_tap: true,
    })
    expect(b.payload.summary).toMatch(/Approving starts the reactions scrape now \(one approval; bill \$2\.00\)/)
    expect(b.payload.summary.startsWith('Peter Lohmann · 1 chosen post · reactions ≤1,000 ($2.00, Apify hard cap $2.25) · verify cap $2. ')).toBe(true)
    expect(b.payload.summary).toMatch(/Shared Apify cap: \$8\.50 of \$29 left/)
    expect(influencerPayloadError('influencer_run', b.payload)).toBeNull()
  })
  it('dedupes and prices several posts', async () => {
    store.getInfluencersBySlugs.mockResolvedValue([inf({ max_reactions_per_post: 300 })])
    const b = await buildInfluencerRun({ slugs: ['peter-lohmann'], post_urls: [U1, U2, `${U2}/`] })
    if (!b.ok) throw new Error(b.error)
    expect(b.payload).toMatchObject({ post_urls: [U1, U2], reactions_max: 600, reactions_usd: 1.2, reactions_max_charge_usd: 1.37, max_verify_usd: 10 })
    expect(b.payload.summary).toMatch(/^Peter Lohmann · 2 chosen posts · reactions ≤600 \(\$1\.20, Apify hard cap \$1\.37\) · verify cap \$10\./)
  })
  it('needs exactly one influencer and 1-10 valid post URLs', async () => {
    store.getInfluencersBySlugs.mockResolvedValue([peter, deb])
    expect(await buildInfluencerRun({ slugs: ['peter-lohmann', 'deb-newell'], post_urls: [U1] })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/exactly one influencer/) })
    store.getInfluencersBySlugs.mockResolvedValue([peter])
    expect(await buildInfluencerRun({ slugs: ['peter-lohmann'], post_urls: ['https://www.linkedin.com/in/pslohmann'] })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/invalid post_urls/) })
    expect(await buildInfluencerRun({ slugs: ['peter-lohmann'], post_urls: [] })).toMatchObject({ ok: false, status: 400 })
    const eleven = Array.from({ length: 11 }, (_, i) => `https://www.linkedin.com/feed/update/urn:li:activity:${i + 1}`)
    expect(await buildInfluencerRun({ slugs: ['peter-lohmann'], post_urls: eleven })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/at most 10/) })
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
    expect(b.payload.summary).toMatch(/Shared Apify cap: \$8\.50 of \$29 left this month \(ledger, Settings → Budget\); an influencer that would pass it is skipped/)
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
    expect(Object.keys(fn.callInfluencerFn.mock.calls[0][0])).toEqual(['action', 'influencer_ids', 'max_verify_usd', 'start_action_id', 'estimate'])
  })
  it('URL mode forwards post_urls and reports the run waiting on the reactions approval', async () => {
    const U = 'https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000001'
    store.getInfluencersByIds.mockResolvedValue([peter])
    fn.callInfluencerFn.mockResolvedValue({ ok: true, status: 202, body: { ok: true, run_id: RUN, status: 'awaiting_approval', stage: 'reactions', reactions_estimate_usd: 1.5 } })
    const out = await executeInfluencerRun({ pipeline: INFLUENCER_PIPELINE, influencer_ids: [P], post_urls: [U], max_verify_usd: 2, posts_usd: 0, summary: 's' }, ACTION)
    expect(out).toEqual({ ok: true, result: { run_id: RUN, status: 'awaiting_approval', stage: 'reactions', post_urls: [U] } })
    expect(fn.callInfluencerFn.mock.calls[0][0]).toMatchObject({ action: 'start', influencer_ids: [P], post_urls: [U], max_verify_usd: 2, start_action_id: ACTION })
  })
  describe('one_tap (single card for chosen posts)', () => {
    const U = 'https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000001'
    const card = { pipeline: INFLUENCER_PIPELINE, influencer_ids: [P], post_urls: [U], one_tap: true, reactions_usd: 1.5, max_verify_usd: 2, posts_usd: 0, summary: 's' }
    const started = { ok: true, status: 202, body: { ok: true, run_id: RUN, status: 'awaiting_approval', stage: 'reactions', reactions_estimate_usd: 1.5 } }
    it('files the run without a bill alert, then approves exactly that bill', async () => {
      store.getInfluencersByIds.mockResolvedValue([peter])
      fn.callInfluencerFn.mockResolvedValueOnce(started).mockResolvedValueOnce({ ok: true, status: 202, body: { ok: true } })
      expect(await executeInfluencerRun(card, ACTION)).toEqual({ ok: true, result: { run_id: RUN, status: 'running', stage: 'reactions', post_urls: [U], approved_usd: 1.5 } })
      expect(fn.callInfluencerFn.mock.calls[0][0]).toMatchObject({ action: 'start', post_urls: [U], one_tap: true, start_action_id: ACTION })
      expect(fn.callInfluencerFn.mock.calls[1][0]).toEqual({ action: 'approve_reactions', run_id: RUN, approved_usd: 1.5, reactions_action_id: ACTION, max_verify_usd: 2 })
    })
    it('a different bill on the run is not approved: the run waits, with a note', async () => {
      store.getInfluencersByIds.mockResolvedValue([peter])
      fn.callInfluencerFn.mockResolvedValueOnce({ ...started, body: { ...started.body, reactions_estimate_usd: 3 } })
      const out = await executeInfluencerRun(card, ACTION)
      expect(out).toMatchObject({ ok: true, result: { run_id: RUN, status: 'awaiting_approval', note: expect.stringMatching(/\$3\.00.*\$1\.50/) } })
      expect(fn.callInfluencerFn).toHaveBeenCalledTimes(1)
    })
    it('a refused approve leaves the run waiting and says so', async () => {
      store.getInfluencersByIds.mockResolvedValue([peter])
      fn.callInfluencerFn.mockResolvedValueOnce(started).mockResolvedValueOnce({ ok: false, status: 409, error: 'not_awaiting_or_bill_changed' })
      expect(await executeInfluencerRun(card, ACTION)).toMatchObject({ ok: true, result: { status: 'awaiting_approval', note: expect.stringMatching(/not_awaiting_or_bill_changed/) } })
    })
    it('an older card without one_tap keeps two approvals', async () => {
      store.getInfluencersByIds.mockResolvedValue([peter])
      fn.callInfluencerFn.mockResolvedValueOnce(started)
      const old: Record<string, unknown> = { ...card }
      delete old.one_tap
      expect(await executeInfluencerRun(old as never, ACTION)).toMatchObject({ ok: true, result: { status: 'awaiting_approval' } })
      expect(fn.callInfluencerFn).toHaveBeenCalledTimes(1)
      expect(fn.callInfluencerFn.mock.calls[0][0]).not.toHaveProperty('one_tap')
    })
  })
  it('fails when an influencer was deactivated or another run became active; nothing is called', async () => {
    store.getInfluencersByIds.mockResolvedValue([peter, { ...deb, active: false }])
    expect(await executeInfluencerRun(payload, ACTION)).toMatchObject({ ok: false, result: { influencer_ids: [D] } })
    store.getInfluencersByIds.mockResolvedValue([peter, deb])
    store.activeRun.mockResolvedValue({ id: 'other', status: 'running', start_action_id: 'someone-else' })
    expect(await executeInfluencerRun(payload, ACTION)).toMatchObject({ ok: false, error: 'another influencer run is active' })
    expect(fn.callInfluencerFn).not.toHaveBeenCalled()
  })
  it('a timeout or an unreachable function is uncertain: check before retrying', async () => {
    store.getInfluencersByIds.mockResolvedValue([peter, deb])
    for (const error of ['timeout', 'unreachable']) {
      fn.callInfluencerFn.mockResolvedValueOnce({ ok: false, status: 0, error })
      const out = await executeInfluencerRun(payload, ACTION)
      expect(out).toMatchObject({ ok: false, result: { uncertain: true } })
      if (!out.ok) expect(String(out.result.note)).toMatch(/get_influencer_run/)
    }
    fn.callInfluencerFn.mockResolvedValueOnce({ ok: false, status: 0, error: 'not_configured' })
    const out = await executeInfluencerRun(payload, ACTION)
    expect(out.ok || out.result.uncertain).toBeFalsy()
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
  it('a timeout approving the bill is uncertain', async () => {
    store.getRun.mockResolvedValue(awaiting)
    fn.callInfluencerFn.mockResolvedValue({ ok: false, status: 0, error: 'timeout' })
    expect(await executeInfluencerReactions(payload, ACTION)).toMatchObject({ ok: false, result: { uncertain: true, run_id: RUN } })
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
    const U = 'https://www.linkedin.com/feed/update/urn:li:activity:1'
    expect(influencerPayloadError('influencer_run', { pipeline: INFLUENCER_PIPELINE, influencer_ids: [P], max_verify_usd: 5, post_urls: [U] })).toBeNull()
    expect(influencerPayloadError('influencer_run', { pipeline: INFLUENCER_PIPELINE, influencer_ids: [P, D], max_verify_usd: 5, post_urls: [U] })).toMatch(/exactly one/)
    expect(influencerPayloadError('influencer_run', { pipeline: INFLUENCER_PIPELINE, influencer_ids: [P], max_verify_usd: 5, post_urls: ['https://x.com/a'] })).toMatch(/post_urls/)
    expect(influencerPayloadError('influencer_run', { pipeline: INFLUENCER_PIPELINE, influencer_ids: [P], max_verify_usd: 5, post_urls: [] })).toMatch(/post_urls/)
    expect(influencerPayloadError('influencer_reactions', { run_id: RUN, max_verify_usd: 5 })).toMatch(/reactions_usd/)
    expect(influencerPayloadError('influencer_reactions', { run_id: RUN, reactions_usd: 1, max_verify_usd: 5 })).toBeNull()
  })
})
