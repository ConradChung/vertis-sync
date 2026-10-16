import 'server-only'
import {
  getAnalyticsOverview,
  getDailyAnalytics,
  isInstantlyConfigured,
  listAccounts,
  listCampaigns,
  mapLimit,
} from '@/lib/adapters/instantly'
import { seriesOn, type AnalyticsOverview, type DailyPoint, type InstantlyAccount } from '@/lib/adapters/instantly.map'
import {
  getCampaigns,
  getEventStamps,
  getEventsByTypePrefix,
  getOverview,
  getRecentEvents,
  getScheduledJobs,
} from '@/lib/db/service'
import type { LumeCampaignRow } from '@/lib/db/types'
import { campaignHealth, countByCampaign, countByDay } from '@/lib/overview/compute'
import type { CampaignStripItem, OverviewInstantly, OverviewPayload } from '@/lib/overview/types'
import { upcoming, withNextRun } from '@/lib/schedule/nextRun'
import { lastNOwnerDates, ownerDate, ownerDayStart } from '@/lib/time/owner'

export const FEED_TYPES = ['reply', 'interested', 'bounce']
const MAX_LISTED_CAMPAIGNS = 12
const CAMPAIGN_CONCURRENCY = 4
const DAYS = 7

const byOwnerDay = (t: number) => ownerDate(t)

/**
 * The database half of the Overview. Days are the owner's (America/Los_Angeles),
 * the same boundary `lume_overview()` uses, so the Replies tile, its delta and
 * its sparkline agree. Throws on DB errors (the route maps them to a 500).
 */
export async function buildOverview(now: Date = new Date()): Promise<OverviewPayload> {
  const days = lastNOwnerDates(now, DAYS)
  const since = ownerDayStart(days[0]).toISOString()

  const [overview, jobs, reply_feed, agent_activity, replyStamps, gateStamps] = await Promise.all([
    getOverview(),
    getScheduledJobs(),
    getRecentEvents({ types: FEED_TYPES, limit: 30 }),
    getEventsByTypePrefix(['agent.', 'lume.'], 12),
    getEventStamps({ types: ['reply'], sinceIso: since }),
    // One `lume.gate_ping` per gate the `lume_gate_opened()` trigger reports:
    // the honest daily series behind "Pending approvals" (opened, not pending).
    getEventStamps({ types: ['lume.gate_ping'], sinceIso: since }),
  ])

  const scheduled_jobs = withNextRun(jobs, now)
  return {
    ...overview,
    scheduled_jobs,
    next_runs: upcoming(scheduled_jobs, 3),
    days,
    replies_7d: countByDay(replyStamps, days, byOwnerDay),
    gates_opened_7d: countByDay(gateStamps, days, byOwnerDay),
    reply_feed,
    agent_activity,
  }
}

type Target = { id: string; name: string; status: string; valueUsd: number | null }

/**
 * The Instantly half: workspace-wide KPIs (2 calls, no campaign id), the
 * accounts, and the campaign strip (per-campaign calls, at most 4 at a time).
 * Never throws for Instantly failures: the KPI half reports `error`, each
 * strip row degrades on its own, and accounts that loaded are kept.
 */
export async function buildOverviewInstantly(now: Date = new Date()): Promise<OverviewInstantly> {
  // Instantly's daily analytics are dated in its workspace timezone; ask for
  // the owner's last 7 dates and align on those strings.
  const dates = lastNOwnerDates(now, DAYS)
  const since24h = new Date(now.getTime() - 86_400_000).toISOString()

  const [lumeCampaigns, bounceStamps] = await Promise.all([
    getCampaigns(),
    getEventStamps({ types: ['bounce'], sinceIso: since24h }),
  ])
  const bounces = countByCampaign(bounceStamps)
  const others = otherCampaigns(lumeCampaigns, bounces)

  const registered: Target[] = lumeCampaigns
    .filter((c) => c.sender_type === 'instantly' && c.external_id)
    .map((c) => ({ id: c.external_id!, name: c.name, status: c.status, valueUsd: c.opportunity_value_usd }))

  if (!isInstantlyConfigured()) {
    return {
      configured: false,
      campaigns: [...registered.map((t) => idleItem(t, bounces.get(t.id) ?? 0, 'Instantly not connected')), ...others],
    }
  }

  const range = { startDate: dates[0], endDate: dates[dates.length - 1] }

  const targetsP: Promise<{ targets: Target[]; source: 'lume_campaigns' | 'instantly_list' }> = registered.length
    ? Promise.resolve({ targets: registered, source: 'lume_campaigns' })
    : listCampaigns()
        .then((all) => {
          // No Instantly rows in lume_campaigns yet: use Instantly's own list.
          const active = all.filter((c) => c.status === 1)
          const targets = (active.length ? active : all)
            .slice(0, MAX_LISTED_CAMPAIGNS)
            .map((c) => ({ id: c.id, name: c.name, status: c.statusLabel, valueUsd: null }))
          return { targets, source: 'instantly_list' as const }
        })
        .catch((err: unknown) => {
          logErr('campaign list', err)
          return { targets: [] as Target[], source: 'instantly_list' as const }
        })

  const [wsTotals, wsDaily, accounts, { targets, source }] = await Promise.all([
    getAnalyticsOverview().catch((err: unknown) => (logErr('workspace overview', err), null)),
    getDailyAnalytics(range).catch((err: unknown) => (logErr('workspace daily', err), null)),
    listAccounts().catch((err: unknown): InstantlyAccount[] | undefined => (logErr('accounts', err), undefined)),
    targetsP,
  ])

  const perCampaign = await mapLimit(targets, CAMPAIGN_CONCURRENCY, async (t) => {
    const [daily, totals] = await Promise.allSettled([
      getDailyAnalytics({ campaignId: t.id, ...range }),
      getAnalyticsOverview(t.id),
    ])
    return {
      t,
      daily: daily.status === 'fulfilled' ? daily.value : null,
      totals: totals.status === 'fulfilled' ? totals.value : null,
    }
  })

  const strip = perCampaign.map(({ t, daily, totals }) => stripItem(t, daily, totals, dates, bounces.get(t.id) ?? 0))
  const campaigns = [...strip, ...others]

  if (!wsTotals || !wsDaily) {
    return { configured: true, error: 'instantly_unreachable', campaign_source: source, accounts, campaigns }
  }

  const sent_7d = seriesOn(dates, 'sent', wsDaily)
  const valued = perCampaign.filter((p) => p.t.valueUsd !== null && (p.totals?.opportunities ?? 0) > 0)
  return {
    configured: true,
    campaign_source: source,
    sent_today: sent_7d[sent_7d.length - 1] ?? 0,
    sent_7d,
    opportunities: wsTotals.opportunities,
    opportunities_value_usd: valued.length
      ? valued.reduce((n, p) => n + p.t.valueUsd! * (p.totals?.opportunities ?? 0), 0)
      : null,
    opportunities_7d: seriesOn(dates, 'opportunities', wsDaily),
    accounts,
    campaigns,
  }
}

function logErr(what: string, err: unknown) {
  console.error(`[overview/instantly] ${what}:`, err instanceof Error ? err.message : err)
}

function otherCampaigns(rows: LumeCampaignRow[], bounces: Map<string, number>): CampaignStripItem[] {
  return rows
    .filter((c) => c.sender_type !== 'instantly')
    .map((c) => {
      const id = c.external_id ?? c.id
      const b = bounces.get(id) ?? 0
      return {
        id,
        name: c.name,
        sender: c.sender_type,
        status: c.status,
        reply_rate: null,
        sent: null,
        replies: null,
        series: [],
        bounces_24h: b,
        health: campaignHealth({
          bounces24h: b,
          replyRate: null,
          idleReason: c.sender_type === 'gmail' ? 'Gmail sends are not tracked yet' : 'Queue-based; no reply tracking',
        }),
      }
    })
}

function idleItem(t: Target, b: number, reason: string): CampaignStripItem {
  return {
    id: t.id,
    name: t.name,
    sender: 'instantly',
    status: t.status,
    reply_rate: null,
    sent: null,
    replies: null,
    series: [],
    bounces_24h: b,
    health: campaignHealth({ bounces24h: b, replyRate: null, idleReason: reason }),
  }
}

function stripItem(
  t: Target,
  daily: DailyPoint[] | null,
  totals: AnalyticsOverview | null,
  dates: string[],
  b: number
): CampaignStripItem {
  return {
    ...idleItem(t, b, totals ? 'No sends yet' : 'Analytics unavailable'),
    reply_rate: totals?.reply_rate ?? null,
    sent: totals?.sent ?? null,
    replies: totals?.replies ?? null,
    series: daily ? seriesOn(dates, 'sent', daily) : [],
    health: campaignHealth({
      bounces24h: b,
      replyRate: totals?.reply_rate ?? null,
      idleReason: totals ? 'No sends yet' : 'Analytics unavailable',
    }),
  }
}
