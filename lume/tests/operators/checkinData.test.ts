import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  listVerticals: vi.fn(),
  listOperators: vi.fn(),
  touchOperator: vi.fn(),
  getGates: vi.fn(),
  getCampaigns: vi.fn(),
  listEventsSince: vi.fn(),
  listAlerts: vi.fn(),
  listDecidedSince: vi.fn(),
  isInstantlyConfigured: vi.fn(),
  listCampaigns: vi.fn(),
  getAnalyticsOverview: vi.fn(),
}))
vi.mock('@/lib/operators/store', () => ({ listVerticals: h.listVerticals, listOperators: h.listOperators, touchOperator: h.touchOperator }))
vi.mock('@/lib/db/service', () => ({ getGates: h.getGates, getCampaigns: h.getCampaigns, listEventsSince: h.listEventsSince }))
vi.mock('@/lib/alertsStore', () => ({ listAlerts: h.listAlerts, ALERTS_MAX_LIMIT: 200 }))
vi.mock('@/lib/actions/store', () => ({ listDecidedSince: h.listDecidedSince }))
vi.mock('@/lib/adapters/instantly', () => ({
  isInstantlyConfigured: h.isInstantlyConfigured,
  listCampaigns: h.listCampaigns,
  getAnalyticsOverview: h.getAnalyticsOverview,
  mapLimit: async <T, R>(xs: T[], _n: number, fn: (x: T) => Promise<R>) => Promise.all(xs.map(fn)),
}))

import { loadCheckin } from '@/lib/operators/checkinData'

const IC = '04ca2257-5ea6-434e-bf62-f55add156914'
const K = { id: 'v-k', name: 'Kaspen', campaign_ids: [IC, 'gmail:x'], scopes: ['campaign'], is_default: true, created_at: '', archived_at: null }
const R = { id: 'v-r', name: 'Roofers', campaign_ids: [], scopes: ['campaign'], is_default: false, created_at: '', archived_at: null }
const op = (extra = {}) => ({ id: 'op-1', vertical_id: 'v-r', is_master: false, label: 'Roof bot', created_at: '', revoked_at: null, last_seen_at: '2026-10-26T09:00:00Z', ...extra })
const now = new Date('2026-10-26T10:00:00Z')

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.listVerticals.mockResolvedValue([K, R])
  h.listOperators.mockResolvedValue([op(), op({ id: 'op-2', vertical_id: 'v-k', last_seen_at: '2026-10-26T09:30:00Z' })])
  h.getGates.mockResolvedValue([])
  h.getCampaigns.mockResolvedValue([])
  h.listAlerts.mockResolvedValue([])
  h.listDecidedSince.mockResolvedValue([])
  h.listEventsSince.mockResolvedValue([])
  h.isInstantlyConfigured.mockReturnValue(true)
  h.listCampaigns.mockResolvedValue([{ id: IC, name: 'Kaspen R3', status: 1 }])
  h.getAnalyticsOverview.mockImplementation(async (_id: string, r: { startDate: string }) =>
    r.startDate === '2026-10-26' ? { sent: 10, replies: 1, bounced: 0 } : { sent: 70, replies: 5, bounced: 2 }
  )
})

describe('loadCheckin', () => {
  it('a vertical bot: scoped to its vertical, check-in recorded, last_checked_at is the previous one', async () => {
    const d = await loadCheckin({ operator: op(), verticalParam: null, now })
    expect(d.scope).toEqual({ all: false, vertical: R })
    expect(h.touchOperator).toHaveBeenCalledWith('op-1')
    expect(d.summary.last_checked_at).toBe('2026-10-26T09:00:00Z')
    expect(d.summary.vertical).toEqual({ id: 'v-r', name: 'Roofers' })
    expect(d.campaignsNote).toMatch(/no campaigns mapped/)
  })

  it('the owner with ?vertical: that vertical, no check-in; latest bot check-in shown; stats for today + 7d', async () => {
    const d = await loadCheckin({ operator: null, verticalParam: 'v-k', now })
    expect(h.touchOperator).not.toHaveBeenCalled()
    expect(d.summary.last_checked_at).toBe('2026-10-26T09:30:00Z')
    expect(d.campaigns).toEqual([
      { id: IC, name: 'Kaspen R3', today: { sent: 10, replies: 1, bounced: 0 }, week: { sent: 70, replies: 5, bounced: 2 }, note: null },
      { id: 'gmail:x', name: 'gmail:x', today: null, week: null, note: 'Not an Instantly campaign: no send stats here' },
    ])
    expect(h.getAnalyticsOverview).toHaveBeenCalledWith(IC, { startDate: '2026-10-20', endDate: '2026-10-26' }, expect.any(AbortSignal))
  })

  it('the master bot and the owner without a param see everything', async () => {
    expect((await loadCheckin({ operator: op({ is_master: true, vertical_id: null }), verticalParam: null, now })).scope).toEqual({ all: true })
    expect((await loadCheckin({ operator: null, verticalParam: null, now })).summary.vertical).toBe('all')
  })

  it('stats that miss the budget: the campaigns that answered keep their numbers; Instantly calls get the signal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const IC2 = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
    h.listVerticals.mockResolvedValue([{ ...K, campaign_ids: [IC, IC2] }, R])
    h.getAnalyticsOverview.mockImplementation((id: string, _r: unknown, signal: AbortSignal) =>
      id === IC
        ? Promise.resolve({ sent: 1, replies: 0, bounced: 0 })
        : new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    )
    const p = loadCheckin({ operator: null, verticalParam: 'v-k', now })
    await vi.advanceTimersByTimeAsync(6_100)
    const d = await p
    vi.useRealTimers()
    expect(d.campaigns.find((c) => c.id === IC)!.today).toEqual({ sent: 1, replies: 0, bounced: 0 })
    expect(d.campaigns.find((c) => c.id === IC2)!.note).toMatch(/too slow/)
    expect(d.campaignsNote).toMatch(/longer than 6 s/)
    expect(h.getAnalyticsOverview.mock.calls[0][2]).toBeInstanceOf(AbortSignal)
  })

  it('a campaign-name query is searched under the same budget', async () => {
    h.listCampaigns.mockResolvedValue([{ id: 'c1', name: 'Scaleport - R3', status: 1 }, { id: 'c2', name: 'Scaleport - M', status: 1 }])
    const d = await loadCheckin({ operator: null, verticalParam: null, campaignQuery: 'scaleport', now })
    expect(d.campaignMatches).toEqual([{ id: 'c1', name: 'Scaleport - R3', status: 1 }, { id: 'c2', name: 'Scaleport - M', status: 1 }])
    expect(h.listCampaigns).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
  })

  it('an unknown ?vertical falls back to all and says so; a failing part is reported, not thrown', async () => {
    h.getGates.mockRejectedValue(new Error('db down'))
    const d = await loadCheckin({ operator: null, verticalParam: 'nope', now })
    expect(d.scope).toEqual({ all: true })
    // Fixed text only; the raw error is logged, never shown.
    expect(d.errors).toEqual(['That vertical does not exist; showing all verticals.', 'Could not load Needs confirmation; reload before deciding anything.'])
    expect(d.errors.join(' ')).not.toContain('db down')
  })

  it('loads 24 h of gate decisions and campaign picks for Recent outcomes', async () => {
    h.listEventsSince.mockResolvedValue([
      { id: 1, type: 'lume.campaign_pick', source: 'lume', source_id: 'j', campaign_id: IC, lead_email: null, title: 'Campaign picked', payload: {}, webhook_id: null, created_at: '2026-10-26T09:00:00Z' },
    ])
    const d = await loadCheckin({ operator: null, verticalParam: 'v-k', now })
    expect(h.listEventsSince).toHaveBeenCalledWith(['lume.decision', 'lume.campaign_pick'], new Date('2026-10-25T10:00:00Z'))
    expect(d.decisionEvents.map((e) => e.kind)).toEqual(['campaign_pick'])
  })
})
