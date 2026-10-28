import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let user: { email: string } | null = { email: 'owner@example.com' }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: user ? { claims: { sub: 'owner-id', ...user } } : null }) } }),
}))

const hist = vi.hoisted(() => ({ archivedLeadHistory: vi.fn() }))
vi.mock('@/lib/leads/cycledStore', () => hist)

import { GET as leadsGET } from '@/app/api/campaigns/[id]/leads/route'
import { GET as usageGET } from '@/app/api/instantly/usage/route'

const CID = '0b6c6d2e-1111-4222-8333-444455556666'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const ctx = (id = CID) => ({ params: Promise.resolve({ id }) })
const req = (path: string) => new Request(`http://localhost${path}`)
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  user = { email: 'owner@example.com' }
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  process.env.INSTANTLY_API_KEY = 'k'
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  hist.archivedLeadHistory.mockReset()
  hist.archivedLeadHistory.mockResolvedValue({ total: 0, replied: 0, bounced: 0, finished_no_reply: 0, removed_by_lume: 0 })
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_KEY
})

describe('GET /api/campaigns/[id]/leads', () => {
  it('lists leads in a state with a summary', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [{ id: 'l1', email: 'a@x.com', first_name: 'A', status: -1, email_reply_count: 0 }, { id: 'l2', email: 'b@x.com', status: -1 }] })
    )
    const res = await leadsGET(req(`/api/campaigns/${CID}/leads?state=bounced&limit=1`), ctx())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ configured: true, campaign_id: CID, state: 'bounced', returned: 1, matched: 2, truncated: false })
    expect(body.summary.by_status).toEqual({ bounced: 2 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).filter).toBe('FILTER_VAL_BOUNCED')
  })
  it('400 on an unknown state; {configured:false} without a key; 401 without the owner', async () => {
    expect((await leadsGET(req(`/api/campaigns/${CID}/leads?state=all`), ctx())).status).toBe(400)
    delete process.env.INSTANTLY_API_KEY
    expect(await (await leadsGET(req(`/api/campaigns/${CID}/leads?state=replied`), ctx())).json()).toEqual({ configured: false })
    user = null
    expect((await leadsGET(req(`/api/campaigns/${CID}/leads?state=replied`), ctx())).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('502 when Instantly fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'x' }, 500))
    expect((await leadsGET(req(`/api/campaigns/${CID}/leads?state=replied`), ctx())).status).toBe(502)
  })
})

describe('GET /api/instantly/usage', () => {
  it('returns current, limit and headroom', async () => {
    fetchMock.mockResolvedValueOnce(json({ subscriptions: { outreach: { plan_name: 'Growth', current_lead_count: 900, total_lead_limit: 1000 } } }))
    expect(await (await usageGET(req('/api/instantly/usage'))).json()).toMatchObject({ configured: true, current: 900, limit: 1000, headroom: 100 })
  })
  it('{configured:false} without a key', async () => {
    delete process.env.INSTANTLY_API_KEY
    expect(await (await usageGET(req('/api/instantly/usage'))).json()).toEqual({ configured: false })
  })
})

describe('GET /api/campaigns/[id]/leads: history of leads no longer in Instantly', () => {
  it('adds lead_bank history and a note, so 0 in Instantly is not read as "never replied"', async () => {
    hist.archivedLeadHistory.mockResolvedValue({ total: 225, replied: 18, bounced: 26, finished_no_reply: 69, removed_by_lume: 0 })
    fetchMock.mockResolvedValueOnce(json({ items: [] }))
    const body = await (await leadsGET(req(`/api/campaigns/${CID}/leads?state=replied`), ctx())).json()
    expect(body).toMatchObject({ matched: 0, scope: 'in_instantly_now' })
    expect(body.history).toEqual({ source: 'lead_bank', no_longer_in_instantly: { total: 225, replied: 18, bounced: 26, finished_no_reply: 69 }, removed_by_lume: 0 })
    expect(body.note).toMatch(/18 replied lead.* no longer in Instantly/)
    expect(hist.archivedLeadHistory).toHaveBeenCalledWith(CID)
  })
  it('a history failure never fails the route', async () => {
    hist.archivedLeadHistory.mockRejectedValue(new Error('db down'))
    fetchMock.mockResolvedValueOnce(json({ items: [] }))
    const res = await leadsGET(req(`/api/campaigns/${CID}/leads?state=bounced`), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).history_error).toBeTruthy()
  })
})
