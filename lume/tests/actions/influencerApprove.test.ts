import { beforeEach, describe, expect, it, vi } from 'vitest'

/** influencer_approve: the agent's approval of found candidates (always asks); the page button stays a direct click. */

const h = vi.hoisted(() => ({ getCandidatesByIds: vi.fn(), approveCandidates: vi.fn() }))
vi.mock('@/lib/influencers/candidateStore', () => ({ getCandidatesByIds: h.getCandidatesByIds, approveCandidates: h.approveCandidates }))

import { buildInfluencerApprove, executeInfluencerApprove } from '@/lib/influencers/approveAction'
import { approvePayloadError } from '@/lib/influencers/actionPayload'

const id = (n: number) => `${String(n).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const cand = (n: number, o: Record<string, unknown> = {}) => ({ id: id(n), name: `Person ${n}`, company: 'Acme', status: 'found', confidence: 'high', linkedin_url: `https://www.linkedin.com/in/p${n}`, ...o })

beforeEach(() => {
  vi.resetAllMocks()
  h.getCandidatesByIds.mockResolvedValue([cand(1), cand(2, { confidence: 'medium' }), cand(3, { status: 'not_found', linkedin_url: null })])
  h.approveCandidates.mockResolvedValue({ approved: [{ candidate_id: id(1), influencer_id: 'i1', created: true }], skipped: [] })
})

describe('buildInfluencerApprove', () => {
  it('keeps only found candidates with a URL; the summary names them, their profiles and confidence', async () => {
    const b = await buildInfluencerApprove({ candidate_ids: [id(3), id(2), id(1)].map((x) => x.toUpperCase()) })
    if (!b.ok) throw new Error(b.error)
    expect(b.kind).toBe('influencer_approve')
    expect(b.payload.candidate_ids).toEqual([id(1), id(2)])
    expect(b.payload.summary).toMatch(/Approve 2 influencer candidates as INACTIVE influencers/)
    expect(b.payload.summary).toMatch(/Person 1 \(Acme\) linkedin\.com\/in\/p1 · high/)
    expect(b.payload.summary).toMatch(/1 skipped \(not found, already reviewed or no profile\)/)
    expect(approvePayloadError(b.payload)).toBeNull()
  })
  it('refuses when none of them can be approved', async () => {
    h.getCandidatesByIds.mockResolvedValue([cand(3, { status: 'not_found', linkedin_url: null })])
    expect(await buildInfluencerApprove({ candidate_ids: [id(3)] })).toEqual({ ok: false, status: 409, error: 'nothing_to_approve' })
    expect(await buildInfluencerApprove({ candidate_ids: [] })).toMatchObject({ ok: false, status: 400 })
  })
})

describe('executeInfluencerApprove (after the tap)', () => {
  it('approves exactly the snapshot ids (approveCandidates only changes rows still found)', async () => {
    const out = await executeInfluencerApprove({ candidate_ids: [id(1), id(2)], summary: 's' })
    expect(h.approveCandidates).toHaveBeenCalledWith([id(1), id(2)])
    expect(out).toEqual({ ok: true, result: { approved: 1, created: 1, linked: 0, skipped: [] } })
  })
  it('payload check: lowercase uuids, 1-1000', () => {
    expect(approvePayloadError({ candidate_ids: [id(1)], summary: 's' })).toBeNull()
    expect(approvePayloadError({ candidate_ids: [], summary: 's' })).toMatch(/candidate_ids/)
    expect(approvePayloadError({ candidate_ids: [id(1).toUpperCase()], summary: 's' })).toMatch(/candidate_ids/)
  })
})
