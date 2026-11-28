import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ email: 'owner@example.com' as string | null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: session.email ? { claims: { sub: 'u', email: session.email } } : null }) } }),
}))
const store = vi.hoisted(() => ({ loadExport: vi.fn(), loadInbox: vi.fn(), patchAccount: vi.fn(), startDeal: vi.fn(), loadAllRows: vi.fn() }))
vi.mock('@/lib/signals/store', () => store)
const held = vi.hoisted(() => ({ typeHiringUnits: vi.fn() }))
vi.mock('@/lib/signals/held', () => held)
const portal = vi.hoisted(() => ({ getPortalUser: vi.fn() }))
vi.mock('@/lib/portal/access', async () => ({ ...(await vi.importActual<object>('@/lib/portal/access')), getPortalUser: portal.getPortalUser }))
const score = vi.hoisted(() => ({ getScoreboard: vi.fn() }))
vi.mock('@/lib/scoreboard/store', () => score)

import { GET as inboxGET } from '@/app/api/signals/inbox/route'
import { PATCH as accountPATCH } from '@/app/api/signals/accounts/route'
import { POST as dealPOST } from '@/app/api/signals/accounts/deal/route'
import { POST as hiringUnitsPOST } from '@/app/api/signals/hiring/[id]/units/route'
import { GET as exportGET } from '@/app/api/signals/export/route'
import { GET as portalGET } from '@/app/api/portal/signals/route'
import type { SignalRow } from '@/lib/signals/merge'

const json = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const row = (o: Partial<SignalRow> & { key: string; name: string }): SignalRow => ({
  aliases: [], domain: null, sources: ['hiring'], count: 1, newest: { source: 'hiring', label: 'Hiring: Regional PM', at: '2026-11-25T00:00:00Z', url: null }, phone: null, contacts: [], events: [], latest: {}, warmth: { tier: 3, at: null },
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
    // Counted over this client's own campaigns plus the signal deals, never every campaign.
    expect(score.getScoreboard).toHaveBeenCalledTimes(1)
    expect(score.getScoreboard.mock.calls[0][1]).toEqual(['c1', 'signals'])
  })

  it('the scoreboard ids come from the portal user row, not the request', async () => {
    session.email = 'owner@example.com'
    portal.getPortalUser.mockResolvedValue({ email: 'frank@kaspen.co', client: 'Kaspen', campaign_ids: ['k1', 'k2'], linkedin_set_ids: [], sheet_set_ids: [] })
    await portalGET(new Request('http://localhost/api/portal/signals?as=frank%40kaspen.co&campaign_ids=other&campaign=all'))
    expect(score.getScoreboard.mock.calls[0][1]).toEqual(['k1', 'k2', 'signals'])
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

describe('GET /api/signals/inbox doors params', () => {
  it('min_doors=500 and sort=doors_desc reach the loader; other values are ignored', async () => {
    await inboxGET(new Request('http://x/api/signals/inbox?min_doors=500&sort=doors_desc'))
    expect(store.loadInbox).toHaveBeenLastCalledWith(expect.objectContaining({ minDoors: 500 }), undefined, 'desc')
    await inboxGET(new Request('http://x/api/signals/inbox?min_doors=7&sort=nope'))
    expect(store.loadInbox).toHaveBeenLastCalledWith(expect.not.objectContaining({ minDoors: expect.anything() }))
  })
})

describe('POST /api/signals/hiring/:id/units', () => {
  const call = (id: string, body: unknown) => hiringUnitsPOST(json('http://x/api/signals/hiring/' + id + '/units', 'POST', body), { params: Promise.resolve({ id }) })
  it('saves the typed count on that hiring row', async () => {
    held.typeHiringUnits.mockResolvedValue({ ok: true })
    expect((await call('31', { units: 750 })).status).toBe(200)
    expect(held.typeHiringUnits).toHaveBeenCalledWith(31, 750)
  })
  it('404 when the row already has a count or is gone; 400 for a bad id or count; 404 without the owner session', async () => {
    held.typeHiringUnits.mockResolvedValue({ ok: false, error: 'not_found' })
    expect((await call('31', { units: 750 })).status).toBe(404)
    expect((await call('abc', { units: 750 })).status).toBe(400)
    expect((await call('31', { units: 0 })).status).toBe(400)
    expect((await call('31', { units: 5, extra: 1 })).status).toBe(400)
    session.email = null
    expect((await call('31', { units: 750 })).status).toBeGreaterThanOrEqual(401)
  })
})

describe('GET /api/signals/export', () => {
  const get = (qs = '', headers: Record<string, string> = {}) => exportGET(new Request('http://localhost/api/signals/export' + qs, { headers }))
  beforeEach(() => {
    store.loadExport.mockResolvedValue({
      rows: [row({ key: 'd:acme.com', name: 'Acme PM', domain: 'acme.com', doors: { count: 1200, source: 'apollo', confidence: 'high' }, latest: { hiring: { ref: 'hiring:1', label: 'x', at: null, url: null, person: null, person_title: null, linkedin: null, detail: null } } })],
      hiring: new Map(),
      failed: [],
    })
  })
  it('signed out is 401, and nothing is read', async () => {
    session.email = null
    expect((await get('?source=hiring&min_doors=500')).status).toBe(401)
    expect(store.loadExport).not.toHaveBeenCalled()
  })
  it('a portal client (any account that is not the owner) is refused, and nothing is read', async () => {
    session.email = 'frank@kaspen.co'
    portal.getPortalUser.mockResolvedValue({ email: 'frank@kaspen.co', client: 'Kaspen', campaign_ids: ['c1'], linkedin_set_ids: [], sheet_set_ids: [] })
    expect((await get('?source=hiring')).status).toBe(403)
    expect(store.loadExport).not.toHaveBeenCalled()
  })
  it('the agent\'s internal bearer is not enough: only the owner\'s own session exports', async () => {
    session.email = null
    expect((await get('', { authorization: 'Bearer internal-secret-for-tests' })).status).toBe(403)
    expect(store.loadExport).not.toHaveBeenCalled()
  })
  it('the owner gets a no-store CSV attachment with a BOM and the tab-named file', async () => {
    const res = await get('?source=hiring&min_doors=500&status=working&q=acme&sort=doors_desc')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="signals-hiring-500plus-\d{4}-\d{2}-\d{2}\.csv"$/)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // UTF-8 BOM
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toContain('Acme PM')
    expect(store.loadExport).toHaveBeenCalledWith(expect.objectContaining({ source: 'hiring', status: 'working', q: 'acme', minDoors: 500 }), 'desc')
  })
  it('Reddit is not exportable', async () => {
    expect((await get('?source=reddit')).status).toBe(400)
  })
})
