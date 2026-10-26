import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) } }),
}))

const crm = vi.hoisted(() => ({
  getStages: vi.fn(),
  getDeals: vi.fn(),
  getDeal: vi.fn(),
  getFollowupIds: vi.fn(),
  getAwaitingCloses: vi.fn(),
  getReplySnippets: vi.fn(),
  getReplyStamps: vi.fn(),
  getActivities: vi.fn(),
  getLeadRow: vi.fn(),
  setStage: vi.fn(),
  updateDeal: vi.fn(),
  searchDeals: vi.fn(),
}))
vi.mock('@/lib/crm/service', () => ({
  ...crm,
  withSnippets: (deals: { id: string }[], s: Record<string, string>) => deals.map((d) => ({ ...d, snippet: s[d.id] ?? null })),
}))

const db = vi.hoisted(() => ({
  insertPendingAction: vi.fn(),
  findAwaitingAction: vi.fn(),
  findAwaitingRuleAction: vi.fn(),
  setActionMessageId: vi.fn(),
  getCampaigns: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({ ...db, isDbError: (e: unknown) => e instanceof Error && 'code' in e }))
const findAwaitingActionBy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/campaigns/service', () => ({ findAwaitingActionBy }))
const sendActionPrompt = vi.hoisted(() => vi.fn())
vi.mock('@/lib/adapters/telegram', () => ({ sendActionPrompt }))
vi.mock('@/lib/adapters/instantly', () => ({ isInstantlyConfigured: () => false, listCampaigns: vi.fn() }))

import { GET as boardGET } from '@/app/api/crm/board/route'
import { GET as dealGET, PATCH as dealPATCH } from '@/app/api/crm/deals/[id]/route'
import { GET as searchGET } from '@/app/api/crm/search/route'
import { DEFAULT_STAGES } from '@/lib/crm/stages'

const DEAL = '5b7f2d1e-3c4a-4e8b-9f0a-1b2c3d4e5f60'
const CAMP = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const patch = (body: unknown) =>
  new Request(`http://localhost/api/crm/deals/${DEAL}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

const deal = (over: Record<string, unknown> = {}) => ({
  id: DEAL, campaign_id: CAMP, lead_id: 12, email: 'ada@example.com', name: 'Ada Lovelace', company: 'Engines', city: 'London',
  source: 'instantly', stage: 'Replied', owner: null, next_action_at: null, next_action: null, last_activity_at: null,
  won_lost_reason: null, notes: null, followup_flagged_at: null, created_at: '', updated_at: '', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  crm.getStages.mockResolvedValue(DEFAULT_STAGES)
  crm.getDeal.mockResolvedValue(deal())
  crm.setStage.mockResolvedValue('Replied')
  crm.getAwaitingCloses.mockResolvedValue({})
  db.getCampaigns.mockResolvedValue([{ external_id: CAMP, name: 'Kaspen Q4' }])
  db.findAwaitingAction.mockResolvedValue(null)
  db.findAwaitingRuleAction.mockResolvedValue(null)
  findAwaitingActionBy.mockResolvedValue(null)
  db.insertPendingAction.mockImplementation(async (row: Record<string, unknown>) => ({ id: 'pa-1', ...row, status: 'awaiting' }))
  sendActionPrompt.mockResolvedValue({ ok: false, messageId: null })
})

describe('PATCH /api/crm/deals/[id] — stage transitions', () => {
  it('a move to Interested applies directly and logs source user', async () => {
    const res = await dealPATCH(patch({ stage: 'Interested' }), ctx(DEAL))
    expect(res.status).toBe(200)
    expect(crm.setStage).toHaveBeenCalledWith(DEAL, 'Interested', 'user')
    expect(db.insertPendingAction).not.toHaveBeenCalled()
  })

  it('a move to Won files a crm_close_deal pending action and does not move the deal', async () => {
    const res = await dealPATCH(patch({ stage: 'Won', reason: 'Signed the pilot' }), ctx(DEAL))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ ok: true, applied: false, pending_action_id: 'pa-1' })
    expect(crm.setStage).not.toHaveBeenCalled()
    const row = db.insertPendingAction.mock.calls[0][0]
    expect(row.kind).toBe('crm_close_deal')
    expect(row.requested_by).toBe('user')
    expect(row.payload).toMatchObject({ deal_id: DEAL, stage: 'Won', reason: 'Signed the pilot', lead_email: 'ada@example.com' })
    expect(row.payload.summary).toContain('Won')
    expect(sendActionPrompt).toHaveBeenCalledTimes(1)
  })

  it('Lost without a reason is a 400 and files nothing', async () => {
    const res = await dealPATCH(patch({ stage: 'Lost' }), ctx(DEAL))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'reason_required' })
    expect(db.insertPendingAction).not.toHaveBeenCalled()
    expect(crm.setStage).not.toHaveBeenCalled()
  })

  it('a second Won/Lost while one is awaiting is a 409', async () => {
    findAwaitingActionBy.mockResolvedValue({ id: 'pa-0' })
    const res = await dealPATCH(patch({ stage: 'Lost', reason: 'no budget' }), ctx(DEAL))
    expect(res.status).toBe(409)
    expect(findAwaitingActionBy).toHaveBeenCalledWith('crm_close_deal', 'deal_id', DEAL)
    expect(db.insertPendingAction).not.toHaveBeenCalled()
  })

  it('unknown stage → 400; bad id → 400; missing deal → 404; unknown field → 400', async () => {
    expect((await dealPATCH(patch({ stage: 'Negotiating' }), ctx(DEAL))).status).toBe(400)
    expect((await dealPATCH(patch({ stage: 'Replied' }), ctx('nope'))).status).toBe(400)
    crm.getDeal.mockResolvedValueOnce(null)
    expect((await dealPATCH(patch({ stage: 'Replied' }), ctx(DEAL))).status).toBe(404)
    expect((await dealPATCH(patch({ email: 'x@y.z' }), ctx(DEAL))).status).toBe(400)
  })

  it('field edits (next action, owner, notes) apply directly', async () => {
    crm.updateDeal.mockResolvedValue(deal({ owner: 'me' }))
    const res = await dealPATCH(patch({ owner: 'me', next_action: 'Send deck', next_action_at: '2026-10-27T16:00:00.000Z', notes: 'warm' }), ctx(DEAL))
    expect(res.status).toBe(200)
    expect(crm.updateDeal).toHaveBeenCalledWith(DEAL, { owner: 'me', next_action: 'Send deck', next_action_at: '2026-10-27T16:00:00.000Z', notes: 'warm' })
    expect(crm.setStage).not.toHaveBeenCalled()
  })
})

describe('GET routes', () => {
  it('deal detail carries stages, timeline, lead row and campaign name', async () => {
    crm.getActivities.mockResolvedValue([{ id: 'a1', kind: 'replied' }])
    crm.getLeadRow.mockResolvedValue({ id: 12, first_name: 'Ada' })
    crm.getAwaitingCloses.mockResolvedValue({ [DEAL]: 'pa-9' })
    const res = await dealGET(new Request(`http://localhost/api/crm/deals/${DEAL}`), ctx(DEAL))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ campaign_name: 'Kaspen Q4', awaiting_close: 'pa-9', lead: { first_name: 'Ada' } })
    expect(body.stages).toHaveLength(8)
  })

  it('board: deals, follow-ups, snippets, campaigns', async () => {
    const d1 = deal()
    const d2 = deal({ id: '6b7f2d1e-3c4a-4e8b-9f0a-1b2c3d4e5f61', email: 'bo@example.com', stage: 'Contacted', owner: 'me' })
    crm.getDeals.mockResolvedValue([d1, d2])
    crm.getFollowupIds.mockResolvedValue([d2.id])
    crm.getReplySnippets.mockResolvedValue({ [DEAL]: 'Sounds good' })
    crm.getReplyStamps.mockResolvedValue([new Date().toISOString()])
    const res = await boardGET(new Request(`http://localhost/api/crm/board?campaign=${CAMP}`))
    expect(res.status).toBe(200)
    const b = await res.json()
    expect(b.deals).toHaveLength(2)
    expect(b.deals[0].snippet).toBe('Sounds good')
    expect(b.followups.map((f: { id: string }) => f.id)).toEqual([d2.id])
    expect(b.replies_14d).toHaveLength(14)
    expect(b.replies_14d.at(-1)).toBe(1)
    expect(b.campaigns).toEqual([{ id: CAMP, name: 'Kaspen Q4' }])
    expect(b.owners).toEqual(['me'])
    expect(crm.getDeals).toHaveBeenCalledWith(CAMP)
  })

  it('board refuses a malformed campaign', async () => {
    expect((await boardGET(new Request('http://localhost/api/crm/board?campaign=a%20b;drop'))).status).toBe(400)
  })

  it('search needs 2+ characters', async () => {
    crm.searchDeals.mockResolvedValue([{ id: DEAL }])
    expect(await (await searchGET(new Request('http://localhost/api/crm/search?q=a'))).json()).toEqual({ deals: [] })
    expect(await (await searchGET(new Request('http://localhost/api/crm/search?q=ada'))).json()).toEqual({ deals: [{ id: DEAL }] })
  })
})
