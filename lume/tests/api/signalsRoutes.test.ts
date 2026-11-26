import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ email: 'owner@example.com' as string | null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: session.email ? { claims: { sub: 'u', email: session.email } } : null }) } }),
}))
const store = vi.hoisted(() => ({ loadInbox: vi.fn(), patchAccount: vi.fn(), startDeal: vi.fn(), loadAllRows: vi.fn() }))
vi.mock('@/lib/signals/store', () => store)
const portal = vi.hoisted(() => ({ getPortalUser: vi.fn() }))
vi.mock('@/lib/portal/access', async () => ({ ...(await vi.importActual<object>('@/lib/portal/access')), getPortalUser: portal.getPortalUser }))
const score = vi.hoisted(() => ({ getScoreboard: vi.fn() }))
vi.mock('@/lib/scoreboard/store', () => score)

import { GET as inboxGET } from '@/app/api/signals/inbox/route'
import { PATCH as accountPATCH } from '@/app/api/signals/accounts/route'
import { POST as dealPOST } from '@/app/api/signals/accounts/deal/route'
import { GET as portalGET } from '@/app/api/portal/signals/route'
import type { SignalRow } from '@/lib/signals/merge'

const json = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const row = (o: Partial<SignalRow> & { key: string; name: string }): SignalRow => ({
  aliases: [], domain: null, sources: ['hiring'], count: 1, newest: { source: 'hiring', label: 'Hiring: Regional PM', at: '2026-11-25T00:00:00Z', url: null }, phone: null, contacts: [], events: [],
  state_key: o.key, status: 'new', touches: { email: null, linkedin: null, call: null }, deal_id: null, ...o,
})
const board = { week: { start: '2026-11-23', end: '2026-11-30', label: 'Nov 23 – Nov 29' }, counts: { conversations: 2, pilots_started: 1, pilots_paid: 0 }, top_objection: 'No budget' }

beforeEach(() => {
  vi.clearAllMocks()
  session.email = 'owner@example.com'
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  process.env.LUME_INTERNAL_SECRET = 'internal-secret-for-tests'
  delete process.env.LUME_SIGNALS_CLIENT
  store.loadInbox.mockResolvedValue({ rows: [], counts: { new: 0, working: 0, replied: 0, dropped: 0 }, total: 0, failed: [] })
  store.patchAccount.mockResolvedValue({ account_key: 'd:acme.com', status: 'working' })
  store.startDeal.mockResolvedValue({ ok: true, deal_id: 'deal-1', campaign_id: 'signals', created: true })
  store.loadAllRows.mockResolvedValue({
    rows: [
      row({ key: 'd:nophone.com', name: 'No Phone Co', domain: 'nophone.com' }),
      row({ key: 'd:acme.com', name: 'Acme PM', domain: 'acme.com', phone: '(310) 555-0101', contacts: [{ name: 'Ada', title: 'COO', linkedin: null }] }),
      row({ key: 'r:pm_dave', name: 'u/pm_dave', sources: ['reddit'] }),
      row({ key: 'd:called.com', name: 'Called Co', phone: '555', touches: { email: null, linkedin: null, call: '2026-11-26T18:00:00Z' }, status: 'working' }),
      row({ key: 'd:dropped.com', name: 'Dropped Co', phone: '555', status: 'dropped' }),
    ],
    failed: [],
  })
  score.getScoreboard.mockResolvedValue(board)
  portal.getPortalUser.mockResolvedValue({ email: 'frank@kaspen.co', client: 'Kaspen', campaign_ids: ['c1'], linkedin_set_ids: [], sheet_set_ids: [] })
})

describe('GET /api/signals/inbox', () => {
  it('owner only', async () => {
    session.email = 'someone@else.com'
    expect([401, 403]).toContain((await inboxGET(new Request('http://localhost/api/signals/inbox'))).status)
    expect(store.loadInbox).not.toHaveBeenCalled()
  })
  it('passes a valid filter and ignores anything else', async () => {
    await inboxGET(new Request('http://localhost/api/signals/inbox?source=reddit&status=open&q=acme'))
    expect(store.loadInbox).toHaveBeenLastCalledWith({ source: 'reddit', status: 'open', q: 'acme' })
    await inboxGET(new Request('http://localhost/api/signals/inbox?source=everything&status=won'))
    expect(store.loadInbox).toHaveBeenLastCalledWith({ source: 'all', status: 'all', q: '' })
  })
})

describe('PATCH /api/signals/accounts', () => {
  const patch = (body: unknown) => accountPATCH(json('http://localhost/api/signals/accounts', 'PATCH', body))
  it('saves a status or a touch', async () => {
    expect((await patch({ key: 'd:acme.com', status: 'replied' })).status).toBe(200)
    expect(store.patchAccount).toHaveBeenLastCalledWith('d:acme.com', { status: 'replied', touch: undefined })
    expect((await patch({ key: 'n:blue door', touch: { channel: 'call', done: true } })).status).toBe(200)
    expect(store.patchAccount).toHaveBeenLastCalledWith('n:blue door', { status: undefined, touch: { channel: 'call', done: true } })
  })
  it('refuses a bad key, status or channel, an empty change and extra fields', async () => {
    for (const bad of [
      { key: 'acme.com', status: 'working' },
      { key: 'd:acme.com', status: 'won' },
      { key: 'd:acme.com', touch: { channel: 'sms', done: true } },
      { key: 'd:acme.com', touch: { channel: 'call' } },
      { key: 'd:acme.com' },
      { key: 'd:acme.com', status: 'working', deal_id: 'x' },
    ]) {
      expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(store.patchAccount).not.toHaveBeenCalled()
  })
  it('404 for a key that is not in the inbox; owner only', async () => {
    store.patchAccount.mockResolvedValue(null)
    expect((await patch({ key: 'd:nope.com', status: 'working' })).status).toBe(404)
    session.email = null
    expect((await patch({ key: 'd:acme.com', status: 'working' })).status).toBe(401)
  })
})

describe('POST /api/signals/accounts/deal (Start deal)', () => {
  const post = (body: unknown, headers?: Record<string, string>) => dealPOST(json('http://localhost/api/signals/accounts/deal', 'POST', body, headers))
  it('201 for a new deal, 200 when it already existed, 404 for an unknown account', async () => {
    const res = await post({ key: 'd:acme.com' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ deal_id: 'deal-1', campaign_id: 'signals' })
    store.startDeal.mockResolvedValue({ ok: true, deal_id: 'deal-1', campaign_id: 'signals', created: false })
    expect((await post({ key: 'd:acme.com' })).status).toBe(200)
    store.startDeal.mockResolvedValue({ ok: false, error: 'not_found' })
    expect((await post({ key: 'd:nope.com' })).status).toBe(404)
  })
  it("needs the owner's own session: the agent's internal bearer cannot start a deal", async () => {
    session.email = null
    const res = await post({ key: 'd:acme.com' }, { authorization: 'Bearer internal-secret-for-tests' })
    expect(res.status).toBe(403)
    expect((await post({ key: 'd:acme.com' })).status).toBe(401)
    expect(store.startDeal).not.toHaveBeenCalled()
  })
  it('refuses a bad body', async () => {
    for (const bad of [{}, { key: 'acme' }, { key: 'd:acme.com', stage: 'Paid' }]) expect((await post(bad)).status).toBe(400)
    expect(store.startDeal).not.toHaveBeenCalled()
  })
})

describe('GET /api/portal/signals', () => {
  const get = (as?: string) => portalGET(new Request('http://localhost/api/portal/signals' + (as ? '?as=' + encodeURIComponent(as) : '')))

  it("the signals client's portal user gets the open accounts to call (phones first) and the scoreboard", async () => {
    session.email = 'frank@kaspen.co'
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.enabled).toBe(true)
    // Reddit authors, called accounts and dropped ones are left out; a phone number sorts first.
    expect(body.accounts.map((a: { key: string }) => a.key)).toEqual(['d:acme.com', 'd:nophone.com'])
    expect(body.accounts[0]).toEqual({
      key: 'd:acme.com', company: 'Acme PM', website: 'acme.com', phone: '(310) 555-0101', sources: ['hiring'], untrusted_signal: 'Hiring: Regional PM',
      signal_at: '2026-11-25T00:00:00Z', contact: { name: 'Ada', title: 'COO', linkedin: null }, status: 'new', called_at: null,
    })
    expect(body.more).toBe(0)
    expect(body.scoreboard).toEqual(board)
  })

  it("another client's portal user gets nothing: no accounts, no scoreboard, and nothing is read", async () => {
    session.email = 'pat@otherclient.com'
    portal.getPortalUser.mockResolvedValue({ email: 'pat@otherclient.com', client: 'Muse', campaign_ids: [], linkedin_set_ids: [], sheet_set_ids: [] })
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false, accounts: [], more: 0, scoreboard: null })
    expect(store.loadAllRows).not.toHaveBeenCalled()
    expect(score.getScoreboard).not.toHaveBeenCalled()
  })

  it('signed out is 401; a stranger is 403; the owner previews with ?as=', async () => {
    session.email = null
    expect((await get()).status).toBe(401)
    session.email = 'stranger@example.com'
    portal.getPortalUser.mockResolvedValue(null)
    expect((await get()).status).toBe(403)
    session.email = 'owner@example.com'
    expect((await get()).status).toBe(400)
    portal.getPortalUser.mockResolvedValue({ email: 'frank@kaspen.co', client: 'Kaspen', campaign_ids: [], linkedin_set_ids: [], sheet_set_ids: [] })
    expect((await get('frank@kaspen.co')).status).toBe(200)
  })

  it('a scoreboard failure still returns the accounts', async () => {
    session.email = 'frank@kaspen.co'
    score.getScoreboard.mockRejectedValue(new Error('boom'))
    const body = await (await get()).json()
    expect(body.scoreboard).toBeNull()
    expect(body.accounts).toHaveLength(2)
  })
})
