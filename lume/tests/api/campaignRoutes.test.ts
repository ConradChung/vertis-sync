import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Owner gate: toggled per test.
let user: { email: string } | null = { email: 'owner@example.com' }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: user ? { claims: { sub: 'owner-id', ...user } } : null }) } }),
}))

const svc = vi.hoisted(() => ({
  getCampaigns: vi.fn(),
  getGatesForTargets: vi.fn(),
  getQueuedCounts: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  getCampaigns: (...a: unknown[]) => svc.getCampaigns(...a),
  getGatesForTargets: (...a: unknown[]) => svc.getGatesForTargets(...a),
  getQueuedCounts: (...a: unknown[]) => svc.getQueuedCounts(...a),
  isDbError: () => false,
  DbError: class extends Error {},
}))
const camp = vi.hoisted(() => ({ getCampaignJobs: vi.fn(), getLastActivity: vi.fn(), getLeadSources: vi.fn(), getCampaignRules: vi.fn() }))
vi.mock('@/lib/campaigns/service', () => ({
  getCampaignJobs: (...a: unknown[]) => camp.getCampaignJobs(...a),
  getLastActivity: (...a: unknown[]) => camp.getLastActivity(...a),
  getLeadSources: (...a: unknown[]) => camp.getLeadSources(...a),
  getCampaignRules: (...a: unknown[]) => camp.getCampaignRules(...a),
}))

import { GET as tableGET } from '@/app/api/campaigns/route'
import { GET as analyticsGET } from '@/app/api/campaigns/[id]/analytics/route'
import { GET as flowGET } from '@/app/api/campaigns/[id]/flow/route'
import { GET as inboxGET } from '@/app/api/campaigns/[id]/inbox/route'
import { clearInstantlyCache } from '@/lib/adapters/instantly'

const CID = '0b6c6d2e-1111-4222-8333-444455556666'
const JOB = '7db3d841-252c-4572-95ec-bc110727df8d'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const ctx = (id = CID) => ({ params: Promise.resolve({ id }) })
const req = (path: string) => new Request(`http://localhost${path}`)

/** Mocked Instantly: GET-only router; records every call. */
function instantlyMock() {
  const calls: { url: string; method: string }[] = []
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    calls.push({ url: url.href, method: init?.method ?? 'GET' })
    const p = url.pathname.replace('/api/v2', '')
    if (p === '/campaigns') return json({ items: [{ id: CID, name: 'Kaspen PM', status: 1 }] })
    if (p === '/campaigns/analytics/overview') return json({ emails_sent_count: 200, reply_count: 5, bounced_count: 2, total_opportunities: 1 })
    if (p === '/campaigns/analytics/daily') return json([{ date: '2026-10-24', sent: 40, replies: 1 }])
    if (p === '/campaigns/analytics/steps') return json([{ step: '0', variant: '0', sent: 150, replies: 4 }, { step: '0', variant: '1', sent: 10 }, { step: 1, sent: 40, replies: 1 }])
    if (p === '/emails')
      return json({
        items: [
          { id: 'e1', thread_id: 't1', ue_type: 1, from_address_email: 'me@send.com', eaccount: 'me@send.com', to_address_email_list: 'lead@x.com', subject: 'Hi', body: { text: 'Pitch' }, timestamp_email: '2026-10-20T10:00:00Z' },
          { id: 'e2', thread_id: 't1', ue_type: 2, from_address_email: 'lead@x.com', eaccount: 'me@send.com', subject: 'Re: Hi', body: { html: '<p>Sounds good</p>' }, timestamp_email: '2026-10-21T10:00:00Z', is_unread: true },
        ],
      })
    return json({ error: 'unexpected' }, 404)
  })
  return { fn, calls }
}

beforeEach(() => {
  user = { email: 'owner@example.com' }
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  process.env.INSTANTLY_API_KEY = 'k'
  clearInstantlyCache()
  svc.getCampaigns.mockReset().mockResolvedValue([
    { id: 'l1', family: 'recruiter', name: 'Recruiter', external_id: 'gmail:recruiter', sender_type: 'gmail', status: 'manual' },
  ])
  svc.getGatesForTargets.mockReset().mockResolvedValue([])
  svc.getQueuedCounts.mockReset().mockResolvedValue({})
  camp.getCampaignJobs.mockReset().mockResolvedValue([])
  camp.getLastActivity.mockReset().mockResolvedValue({ [CID]: '2026-10-24T12:00:00Z' })
  camp.getLeadSources.mockReset().mockResolvedValue({ bank: {}, runs: null, crons: [] })
  camp.getCampaignRules.mockReset().mockResolvedValue([])
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_KEY
})

describe('Campaigns routes are owner-gated', () => {
  it.each([
    ['table', () => tableGET(req('/api/campaigns?with=analytics'))],
    ['analytics', () => analyticsGET(req(`/api/campaigns/${CID}/analytics`), ctx())],
    ['flow', () => flowGET(req(`/api/campaigns/${CID}/flow`), ctx())],
    ['inbox', () => inboxGET(req(`/api/campaigns/${CID}/inbox`), ctx())],
  ])('%s → 401 without a session, no upstream or db call', async (_n, call) => {
    user = null
    const m = instantlyMock()
    vi.stubGlobal('fetch', m.fn)
    const res = await call()
    expect(res.status).toBe(401)
    expect(m.fn).not.toHaveBeenCalled()
    expect(svc.getCampaigns).not.toHaveBeenCalled()
    expect(camp.getCampaignJobs).not.toHaveBeenCalled()
  })

  it('rejects a malformed campaign id', async () => {
    const res = await analyticsGET(req('/api/campaigns/x/analytics'), ctx('../../etc'))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/campaigns', () => {
  it('default → the lume_campaigns registry (+ queued / rotator), no Instantly call', async () => {
    const m = instantlyMock()
    vi.stubGlobal('fetch', m.fn)
    const res = await tableGET(req('/api/campaigns'))
    const registry = (await svc.getCampaigns.mock.results[0].value) as Record<string, unknown>[]
    expect(await res.json()).toEqual(registry.map((c) => ({ ...c, queued: 0, rotator: false })))
    expect(m.fn).not.toHaveBeenCalled()
  })

  it('?with=analytics → registry + Instantly campaigns with totals and last activity', async () => {
    vi.stubGlobal('fetch', instantlyMock().fn)
    const body = await (await tableGET(req('/api/campaigns?with=analytics'))).json()
    expect(body.instantly).toBe('ok')
    expect(body.campaigns).toHaveLength(2)
    expect(body.campaigns[0]).toMatchObject({ key: 'lume:l1', instantly_id: null, sender_type: 'gmail', sent: null })
    expect(body.campaigns[1]).toMatchObject({
      key: CID,
      instantly_id: CID,
      name: 'Kaspen PM',
      family: 'kaspen',
      status: 'active',
      sent: 200,
      replies: 5,
      reply_rate: 2.5,
      opportunities: 1,
      last_activity: '2026-10-24T12:00:00Z',
    })
  })

  it('?with=analytics without a key → registry rows, instantly not_configured', async () => {
    delete process.env.INSTANTLY_API_KEY
    const m = instantlyMock()
    vi.stubGlobal('fetch', m.fn)
    const body = await (await tableGET(req('/api/campaigns?with=analytics'))).json()
    expect(body.instantly).toBe('not_configured')
    expect(body.campaigns).toHaveLength(1)
    expect(m.fn).not.toHaveBeenCalled()
  })
})

describe('GET /api/campaigns/[id]/analytics', () => {
  it('returns overview, daily and per-step totals (variants summed)', async () => {
    vi.stubGlobal('fetch', instantlyMock().fn)
    const res = await analyticsGET(req(`/api/campaigns/${CID}/analytics?days=30`), ctx())
    const body = await res.json()
    expect(body).toMatchObject({ configured: true, campaign_id: CID, days: 30, overview: { sent: 200, replies: 5 } })
    expect(body.daily).toEqual([{ date: '2026-10-24', sent: 40, replies: 1, opportunities: 0 }])
    expect(body.steps).toEqual([
      { step: 1, sent: 160, opened: 0, replies: 4, opportunities: 0 },
      { step: 2, sent: 40, opened: 0, replies: 1, opportunities: 0 },
    ])
  })

  it('without a key → {configured:false}', async () => {
    delete process.env.INSTANTLY_API_KEY
    const res = await analyticsGET(req(`/api/campaigns/${CID}/analytics`), ctx())
    expect(await res.json()).toEqual({ configured: false })
  })
})

describe('GET /api/campaigns/[id]/flow', () => {
  it('sums validation_jobs counts, adds Instantly totals, links the open gate', async () => {
    vi.stubGlobal('fetch', instantlyMock().fn)
    camp.getCampaignJobs.mockResolvedValue([
      { id: JOB, filename: 'a.csv', status: 'completed', instantly_status: 'configuring', total_rows: 100, valid_count: 60, enrich: true, enriched_rows: 50, instantly_pushed: 0, created_at: 'x' },
      { id: 'j2', filename: 'b.csv', status: 'completed', instantly_status: 'done', total_rows: 20, valid_count: 10, enrich: false, enriched_rows: 0, instantly_pushed: 10, created_at: 'y' },
    ])
    svc.getGatesForTargets.mockResolvedValue([{ kind: 'push_review', target_table: 'validation_jobs', target_id: JOB, title: 'Push a.csv' }])
    const body = await (await flowGET(req(`/api/campaigns/${CID}/flow`), ctx())).json()
    expect(camp.getCampaignJobs).toHaveBeenCalledWith(CID)
    expect(body.counts).toEqual({ imported: 120, validated: 70, enriched: 50, pushed: 10, sent: 200, replies: 5, bank_total: 0, bank_queued: 0, rotated: 0, in_campaign: null })
    expect(body.feeders).toEqual([])
    expect(body.bank).toMatchObject({ id: 'bank', count: 0, status: 'idle' })
    expect(body.campaign_status).toBe('active')
    const byId = Object.fromEntries(body.stages.map((s: { id: string }) => [s.id, s]))
    expect(Object.keys(byId)).toEqual(['import', 'validate', 'enrich', 'push', 'send', 'reply'])
    expect(byId.push).toMatchObject({ status: 'waiting', action: { type: 'link', href: `/validate?gate=push_review:${JOB}` } })
    expect(byId.validate.action.type).toBe('disabled')
    expect(byId.send.action).toEqual({ type: 'pending', kind: 'pause_campaign', label: 'Pause' })
  })

  it('a rotation-fed campaign: bank branch + auto-rotation feeder, validation path marked unused', async () => {
    vi.stubGlobal('fetch', instantlyMock().fn)
    camp.getCampaignJobs.mockResolvedValue([])
    svc.getGatesForTargets.mockResolvedValue([])
    camp.getLeadSources.mockResolvedValue({
      bank: { active: 994, queued: 993, completed: 69, replied: 2, bounced: 26, skipped: 128 },
      runs: { count: 35, pushed: 1101, first_at: '2026-10-09T07:42:51Z', last: { ran_at: '2026-10-26T01:00:19Z', pushed: 1, deleted: 1, archived: 0, in_instantly_after: 1000, note: 'rotate', errors: 0 } },
      crons: [{ name: 'instantly-rotate-am', schedule: '0 13 * * *', active: true }, { name: 'instantly-rotate-pm', schedule: '0 1 * * *', active: true }],
    })
    const body = await (await flowGET(req(`/api/campaigns/${CID}/flow`), ctx())).json()
    expect(body.counts).toMatchObject({ imported: 0, bank_total: 2212, bank_queued: 993, rotated: 1101, in_campaign: 1000, sent: 200 })
    expect(body.stages.slice(0, 4).map((s: { status: string }) => s.status)).toEqual(['unused', 'unused', 'unused', 'unused'])
    expect(body.bank).toMatchObject({ status: 'done', count: 2212 })
    expect(body.feeders).toHaveLength(1)
    expect(body.feeders[0]).toMatchObject({ kind: 'system', name: 'Auto-rotation', leads_added: 1101, active: true })
  })

  it('Instantly unconfigured → db counts only, send/reply null', async () => {
    delete process.env.INSTANTLY_API_KEY
    const body = await (await flowGET(req(`/api/campaigns/${CID}/flow`), ctx())).json()
    expect(body.instantly).toBe('not_configured')
    expect(body.counts).toMatchObject({ sent: null, replies: null })
  })
})

describe('GET /api/campaigns/[id]/inbox', () => {
  it('groups emails into threads with the reply target', async () => {
    const m = instantlyMock()
    vi.stubGlobal('fetch', m.fn)
    const body = await (await inboxGET(req(`/api/campaigns/${CID}/inbox`), ctx())).json()
    expect(m.calls[0].url).toContain(`/emails?campaign_id=${CID}`)
    expect(body.configured).toBe(true)
    expect(body.threads).toHaveLength(1)
    const t = body.threads[0]
    expect(t).toMatchObject({
      thread_id: 't1',
      lead: 'lead@x.com',
      unread: true,
      preview: 'Sounds good',
      reply: { reply_to_uuid: 'e2', eaccount: 'me@send.com', subject: 'Re: Hi' },
    })
    expect(t.messages.map((x: { direction: string }) => x.direction)).toEqual(['out', 'in'])
  })

  it('upstream failure → 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await inboxGET(req(`/api/campaigns/${CID}/inbox`), ctx())
    expect(res.status).toBe(502)
  })
})
