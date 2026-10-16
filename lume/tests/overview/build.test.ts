import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LumeCampaignRow } from '@/lib/db/types'

// --- service mock -----------------------------------------------------------
const { svc, ad } = vi.hoisted(() => ({
  svc: {
    getOverview: vi.fn(),
    getScheduledJobs: vi.fn(),
    getRecentEvents: vi.fn(),
    getEventsByTypePrefix: vi.fn(),
    getEventStamps: vi.fn(),
    getCampaigns: vi.fn(),
  },
  ad: {
    isInstantlyConfigured: vi.fn(),
    getAnalyticsOverview: vi.fn(),
    getDailyAnalytics: vi.fn(),
    listAccounts: vi.fn(),
    listCampaigns: vi.fn(),
  },
}))
vi.mock('@/lib/db/service', () => svc)

// --- adapter mock (keep the real mapLimit) ----------------------------------
vi.mock('@/lib/adapters/instantly', async (orig) => {
  const real = await orig<typeof import('@/lib/adapters/instantly')>()
  return { ...real, ...ad }
})

import { buildOverview, buildOverviewInstantly } from '@/lib/overview/build'

const NOW = new Date('2026-10-16T01:35:00Z') // 18:35 PDT on the 15th
const camp = (o: Partial<LumeCampaignRow>): LumeCampaignRow => ({
  id: 'row',
  family: 'kaspen',
  name: 'Row',
  external_id: null,
  sender_type: 'instantly',
  status: 'active',
  capacity_per_day: null,
  opportunity_value_usd: null,
  instantly: null,
  synced_at: null,
  created_at: '2026-10-01T00:00:00Z',
  ...o,
})
const totals = (sent: number, replies: number, opportunities = 0) => ({
  sent,
  replies,
  bounced: 0,
  opportunities,
  opportunity_value: null,
  reply_rate: sent ? (replies / sent) * 100 : null,
})
const ACCOUNTS = [{ email: 'a@x.com', status: 'active', warmup_status: 'active', warmup_score: 90, daily_limit: 40 }]

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  svc.getOverview.mockResolvedValue({ now: NOW.toISOString(), pending_gates: 2, replies_today: 2, bounces_24h: 0, active_jobs: 0, lead_bank_queued: 0, events_last_at: null, recent_events: [] })
  svc.getScheduledJobs.mockResolvedValue([
    { name: 'watchdog', cron: '*/5 * * * *', runner: 'pg_cron', active: true, target: null, last_status: null, last_run_at: null },
    { name: 'bad', cron: 'nope', runner: 'pg_cron', active: true, target: null, last_status: null, last_run_at: null },
  ])
  svc.getRecentEvents.mockResolvedValue([])
  svc.getEventsByTypePrefix.mockResolvedValue([])
  svc.getEventStamps.mockImplementation(async ({ types }: { types: string[] }) => {
    if (types[0] === 'reply') return [{ type: 'reply', campaign_id: null, created_at: '2026-10-16T01:00:00Z' }, { type: 'reply', campaign_id: null, created_at: '2026-10-15T08:00:00Z' }, { type: 'reply', campaign_id: null, created_at: '2026-10-15T06:30:00Z' }]
    if (types[0] === 'lume.gate_ping') return [{ type: 'lume.gate_ping', campaign_id: null, created_at: '2026-10-15T20:00:00Z' }]
    if (types[0] === 'bounce') return Array.from({ length: 5 }, () => ({ type: 'bounce', campaign_id: 'ic-1', created_at: '2026-10-15T20:00:00Z' }))
    return []
  })
  svc.getCampaigns.mockResolvedValue([camp({ id: 'g', name: 'Gmail', sender_type: 'gmail', external_id: 'gmail:r', status: 'manual' })])
  ad.isInstantlyConfigured.mockReturnValue(true)
  ad.listAccounts.mockResolvedValue(ACCOUNTS)
  ad.getDailyAnalytics.mockImplementation(async ({ campaignId }: { campaignId?: string }) =>
    campaignId ? [{ date: '2026-10-15', sent: 10, replies: 1, opportunities: 0 }] : [{ date: '2026-10-14', sent: 90, replies: 0, opportunities: 1 }, { date: '2026-10-15', sent: 120, replies: 2, opportunities: 0 }]
  )
  ad.getAnalyticsOverview.mockImplementation(async (id?: string) => (id ? totals(100, 3, 1) : totals(5000, 80, 7)))
})

describe('buildOverview (database half)', () => {
  it('buckets replies and gate pings on owner-zone days, next_run on jobs', async () => {
    const out = await buildOverview(NOW)
    expect(out.days[6]).toBe('2026-10-15')
    expect(out.replies_7d.slice(-2)).toEqual([1, 2]) // last bucket matches replies_today = 2
    expect(out.gates_opened_7d[6]).toBe(1)
    expect(out.scheduled_jobs.map((j) => j.next_run)).toEqual(['2026-10-16T01:40:00.000Z', null])
    expect(out.next_runs.map((j) => j.name)).toEqual(['watchdog'])
    // the 7-day window starts at Pacific midnight
    expect(svc.getEventStamps).toHaveBeenCalledWith({ types: ['reply'], sinceIso: '2026-10-09T07:00:00.000Z' })
    expect(ad.getAnalyticsOverview).not.toHaveBeenCalled()
  })
})

describe('buildOverviewInstantly', () => {
  it('not configured: no Instantly calls, DB campaigns only', async () => {
    ad.isInstantlyConfigured.mockReturnValue(false)
    svc.getCampaigns.mockResolvedValue([camp({ external_id: 'ic-9', name: 'Reg' }), camp({ id: 'g', name: 'Gmail', sender_type: 'gmail', external_id: 'gmail:r' })])
    const out = await buildOverviewInstantly(NOW)
    expect(out.configured).toBe(false)
    expect(out.campaigns.map((c) => [c.name, c.health.reason])).toEqual([
      ['Reg', 'Instantly not connected'],
      ['Gmail', 'Gmail sends are not tracked yet'],
    ])
    expect(ad.getAnalyticsOverview).not.toHaveBeenCalled()
    expect(ad.listAccounts).not.toHaveBeenCalled()
  })

  it('registered campaigns: KPIs from 2 workspace calls, strip from per-campaign calls, value-weighted opportunities', async () => {
    svc.getCampaigns.mockResolvedValue([
      camp({ external_id: 'ic-1', name: 'Kaspen', opportunity_value_usd: 5000 }),
      camp({ external_id: 'ic-2', name: 'Recruiter', opportunity_value_usd: null }),
    ])
    const out = await buildOverviewInstantly(NOW)
    if (!out.configured) throw new Error('expected configured')
    expect(out.campaign_source).toBe('lume_campaigns')
    expect(out.sent_today).toBe(120)
    expect(out.sent_7d).toEqual([0, 0, 0, 0, 0, 90, 120])
    expect(out.opportunities).toBe(7) // workspace total, not the per-campaign sum
    expect(out.opportunities_value_usd).toBe(5000) // only Kaspen has a value: 1 opp × $5,000
    expect(out.accounts).toEqual(ACCOUNTS)
    expect(ad.listCampaigns).not.toHaveBeenCalled()
    // workspace calls carry no campaign id
    expect(ad.getAnalyticsOverview).toHaveBeenCalledWith()
    expect(ad.getDailyAnalytics).toHaveBeenCalledWith({ startDate: '2026-10-09', endDate: '2026-10-15' })
    const kaspen = out.campaigns.find((c) => c.name === 'Kaspen')!
    expect(kaspen.health.level).toBe('red') // 5 bounces in 24 h
    expect(kaspen.series).toEqual([0, 0, 0, 0, 0, 0, 10])
    expect(out.campaigns.find((c) => c.name === 'Recruiter')!.health.level).toBe('green') // 3%
  })

  it('falls back to Instantly active campaigns when lume_campaigns has none; null value without values', async () => {
    ad.listCampaigns.mockResolvedValue([
      { id: 'x1', name: 'Active', status: 1, statusLabel: 'active' },
      { id: 'x2', name: 'Paused', status: 2, statusLabel: 'paused' },
    ])
    const out = await buildOverviewInstantly(NOW)
    if (!out.configured) throw new Error('expected configured')
    expect(out.campaign_source).toBe('instantly_list')
    expect(out.campaigns.map((c) => c.name)).toEqual(['Active', 'Gmail'])
    expect(out.opportunities_value_usd).toBeNull()
  })

  it('partial failure: one campaign degrades, KPIs still render', async () => {
    svc.getCampaigns.mockResolvedValue([camp({ external_id: 'ok', name: 'OK' }), camp({ external_id: 'boom', name: 'Boom' })])
    ad.getAnalyticsOverview.mockImplementation(async (id?: string) => {
      if (id === 'boom') throw new Error('429')
      return id ? totals(100, 3) : totals(5000, 80, 7)
    })
    ad.getDailyAnalytics.mockImplementation(async ({ campaignId }: { campaignId?: string }) => {
      if (campaignId === 'boom') throw new Error('429')
      return [{ date: '2026-10-15', sent: 10, replies: 0, opportunities: 0 }]
    })
    const out = await buildOverviewInstantly(NOW)
    if (!out.configured) throw new Error('expected configured')
    expect(out.error).toBeUndefined()
    const boom = out.campaigns.find((c) => c.name === 'Boom')!
    expect(boom).toMatchObject({ reply_rate: null, series: [], health: { level: 'idle', reason: 'Analytics unavailable' } })
    expect(out.campaigns.find((c) => c.name === 'OK')!.health.level).toBe('green')
  })

  it('all analytics failed: error set, accounts and strip rows kept', async () => {
    svc.getCampaigns.mockResolvedValue([camp({ external_id: 'ic-1', name: 'Kaspen' })])
    ad.getAnalyticsOverview.mockRejectedValue(new Error('down'))
    ad.getDailyAnalytics.mockRejectedValue(new Error('down'))
    const out = await buildOverviewInstantly(NOW)
    if (!out.configured) throw new Error('expected configured')
    expect(out.error).toBe('instantly_unreachable')
    expect(out.sent_today).toBeUndefined()
    expect(out.accounts).toEqual(ACCOUNTS)
    expect(out.campaigns.map((c) => [c.name, c.reply_rate, c.health.level])).toEqual([['Kaspen', null, 'red']]) // bounces still count
  })

  it('caps per-campaign concurrency at 4', async () => {
    svc.getCampaigns.mockResolvedValue(Array.from({ length: 10 }, (_, i) => camp({ external_id: `c${i}`, name: `C${i}` })))
    let live = 0
    let peak = 0
    ad.getAnalyticsOverview.mockImplementation(async (id?: string) => {
      if (!id) return totals(1, 0)
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 2))
      live--
      return totals(100, 2)
    })
    await buildOverviewInstantly(NOW)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })
})
