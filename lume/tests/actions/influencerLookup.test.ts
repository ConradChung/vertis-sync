import { beforeEach, describe, expect, it, vi } from 'vitest'

/** influencer_lookup: the paid LinkedIn lookup of a staged candidate batch (approve-to-run). */

const h = vi.hoisted(() => ({ getCandidateBatch: vi.fn(), batchCounts: vi.fn(), callInfluencerFn: vi.fn() }))
vi.mock('@/lib/influencers/candidateStore', () => ({ getCandidateBatch: h.getCandidateBatch, batchCounts: h.batchCounts }))
vi.mock('@/lib/adapters/influencerFn', () => ({ callInfluencerFn: h.callInfluencerFn }))

import { buildInfluencerLookup, executeInfluencerLookup } from '@/lib/influencers/lookupAction'
import { lookupPayloadError } from '@/lib/influencers/actionPayload'

const BATCH = '11111111-1111-4111-8111-111111111111'
const ACTION = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.resetAllMocks()
  h.getCandidateBatch.mockResolvedValue({ id: BATCH, name: 'influencers.xlsx · People', status: 'staged', spent_usd: 0 })
  h.batchCounts.mockResolvedValue({ pending_lookup: 146, duplicate: 3 })
  h.callInfluencerFn.mockResolvedValue({ ok: true, status: 202, body: { ok: true, batch_id: BATCH, max_lookup_usd: 1.19 } })
})

describe('buildInfluencerLookup', () => {
  it('prices the people still pending (count x $0.0065) with a hard cap (default +25 %)', async () => {
    const b = await buildInfluencerLookup({ batch_id: BATCH.toUpperCase() })
    if (!b.ok) throw new Error(b.error)
    expect(b.kind).toBe('influencer_lookup')
    expect(b.payload).toMatchObject({ batch_id: BATCH, batch_name: 'influencers.xlsx · People', people: 146, estimate_usd: 0.95, max_usd: 1.19 })
    expect(b.payload.summary).toMatch(/146 people.*~\$0\.95 \(146 × \$0\.0065\).*hard cap \$1\.19/)
    expect(b.payload.summary).toMatch(/only cited profiles/i)
    expect(lookupPayloadError(b.payload)).toBeNull()
  })
  it('an explicit cap is used; one below a single lookup is refused', async () => {
    const b = await buildInfluencerLookup({ batch_id: BATCH, max_usd: 0.5 })
    expect(b.ok && b.payload.max_usd).toBe(0.5)
    expect(await buildInfluencerLookup({ batch_id: BATCH, max_usd: 0.001 })).toMatchObject({ ok: false, status: 400 })
  })
  it('refuses a missing batch, one already looking up, and one with nobody left to look up', async () => {
    h.getCandidateBatch.mockResolvedValueOnce(null)
    expect(await buildInfluencerLookup({ batch_id: BATCH })).toEqual({ ok: false, status: 404, error: 'batch_not_found' })
    h.getCandidateBatch.mockResolvedValueOnce({ id: BATCH, name: 'b', status: 'looking_up', spent_usd: 0 })
    expect(await buildInfluencerLookup({ batch_id: BATCH })).toMatchObject({ ok: false, status: 409, error: 'lookup_running' })
    h.batchCounts.mockResolvedValueOnce({ found: 3 })
    expect(await buildInfluencerLookup({ batch_id: BATCH })).toMatchObject({ ok: false, status: 409, error: 'nothing_to_look_up' })
  })
})

describe('executeInfluencerLookup (after the tap)', () => {
  const approved = { batch_id: BATCH, batch_name: 'b', people: 146, estimate_usd: 0.95, max_usd: 1.19, summary: 's' }
  it('re-checks the batch, then starts the influencer-lookup function with the approved cap and this action id', async () => {
    const out = await executeInfluencerLookup(approved, ACTION)
    expect(out).toEqual({ ok: true, result: { batch_id: BATCH, status: 'looking_up', max_lookup_usd: 1.19 } })
    expect(h.callInfluencerFn).toHaveBeenCalledWith({ action: 'start', batch_id: BATCH, max_usd: 1.19, action_id: ACTION }, 'influencer-lookup')
  })
  it('refuses without calling when the batch is gone, already running, or has nobody pending', async () => {
    h.getCandidateBatch.mockResolvedValueOnce(null)
    expect(await executeInfluencerLookup(approved, ACTION)).toMatchObject({ ok: false })
    h.getCandidateBatch.mockResolvedValueOnce({ id: BATCH, status: 'looking_up' })
    expect(await executeInfluencerLookup(approved, ACTION)).toMatchObject({ ok: false })
    h.batchCounts.mockResolvedValueOnce({})
    expect(await executeInfluencerLookup(approved, ACTION)).toMatchObject({ ok: false })
    expect(h.callInfluencerFn).not.toHaveBeenCalled()
  })
  it('a timed-out start is reported as uncertain (it may have started)', async () => {
    h.callInfluencerFn.mockResolvedValue({ ok: false, status: 0, error: 'timeout' })
    expect(await executeInfluencerLookup(approved, ACTION)).toMatchObject({ ok: false, result: { uncertain: true } })
  })
})

describe('lookupPayloadError', () => {
  it('needs a lowercase batch id, a positive people count and a cap in (0, 50]', () => {
    const ok = { batch_id: BATCH, people: 1, max_usd: 1, summary: 's' }
    expect(lookupPayloadError(ok)).toBeNull()
    expect(lookupPayloadError({ ...ok, batch_id: 'ABCDEF11-1111-4111-8111-111111111111' })).toMatch(/batch_id/)
    expect(lookupPayloadError({ ...ok, max_usd: 51 })).toMatch(/max_usd/)
    expect(lookupPayloadError({ ...ok, people: 0 })).toMatch(/people/)
  })
})
