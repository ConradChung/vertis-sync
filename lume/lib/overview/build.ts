import 'server-only'
import {
  getAnalyticsOverview,
  getDailyAnalytics,
  isInstantlyConfigured,
  listAccounts,
  listCampaigns,
} from '@/lib/adapters/instantly'
import { lastNDates, seriesOn, type AnalyticsOverview, type DailyPoint } from '@/lib/adapters/instantly.map'
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
import type { CampaignStripItem, InstantlySummary, OverviewPayload } from '@/lib/overview/types'
import { upcoming, withNextRun } from '@/lib/schedule/nextRun'

export const FEED_TYPES = ['reply', 'interested', 'bounce']
const MAX_LISTED_CAMPAIGNS = 12
const DAYS = 7

/**
 * Everything the Overview shows, in one response. DB reads throw (the route
 * maps them to a 500); Instantly failures never do — they land in
 * `instantly.error` and the DB half still renders.
 */
export async function buildOverview(now: Date = new Date()): Promise<OverviewPayload> {
  const dates = lastNDates(now, DAYS)
  const since7d = `${dates[0]}T00:00:00Z`
  const since24h = new Date(now.getTime() - 86_400_000).toISOString()

  const [overview, jobs, reply_feed, agent_activity, replyStamps, bounceStamps, lumeCampaigns] = await Promise.all([
    getOverview(),
    getScheduledJobs(),
    getRecentEvents({ types: FEED_TYPES, limit: 30 }),
    getEventsByTypePrefix(['agent.', 'lume.'], 12),
    getEventStamps({ types: ['reply'], sinceIso: since7d }),
    getEventStamps({ types: ['bounce'], sinceIso: since24h }),
    getCampaigns(),
  ])

  const scheduled_jobs = withNextRun(jobs, now)
  const bounces = countByCampaign(bounceStamps)

  const { instantly, strip } = await instantlySection({ lumeCampaigns, dates, bounces })

  const others: CampaignStripItem[] = lumeCampaigns
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

  return {
    ...overview,
    scheduled_jobs,
    next_runs: upcoming(scheduled_jobs, 3),
    replies_7d: countByDay(replyStamps, dates),
    reply_feed,
    agent_activity,
    campaigns: [...strip, ...others],
    instantly,
  }
}

type Target = { id: string; name: string; status: string; valueUsd: number | null }

async function instantlySection({
  lumeCampaigns,
  dates,
  bounces,
}: {
  lumeCampaigns: LumeCampaignRow[]
  dates: string[]
  bounces: Map<string, number>
}): Promise<{ instantly: InstantlySummary; strip: CampaignStripItem[] }> {
  const registered: Target[] = lumeCampaigns
    .filter((c) => c.sender_type === 'instantly' && c.external_id)
    .map((c) => ({ id: c.external_id!, name: c.name, status: c.status, valueUsd: c.opportunity_value_usd }))

  if (!isInstantlyConfigured()) {
    const strip = registered.map((t) => idleItem(t, bounces.get(t.id) ?? 0, 'Instantly not connected'))
    return { instantly: { configured: false }, strip }
  }

  try {
    let targets = registered
    let campaign_source: 'lume_campaigns' | 'instantly_list' = 'lume_campaigns'
    if (!targets.length) {
      // No Instantly rows in lume_campaigns yet: use Instantly's own list.
      const all = await listCampaigns()
      const active = all.filter((c) => c.status === 1)
      targets = (active.length ? active : all)
        .slice(0, MAX_LISTED_CAMPAIGNS)
        .map((c) => ({ id: c.id, name: c.name, status: c.statusLabel, valueUsd: null }))
      campaign_source = 'instantly_list'
    }

    const [perCampaign, accounts] = await Promise.all([
      Promise.all(
        targets.map(async (t) => {
          const [daily, totals] = await Promise.allSettled([
            getDailyAnalytics({ campaignId: t.id, startDate: dates[0], endDate: dates[dates.length - 1] }),
            getAnalyticsOverview(t.id),
          ])
          return {
            t,
            daily: daily.status === 'fulfilled' ? daily.value : null,
            totals: totals.status === 'fulfilled' ? totals.value : null,
          }
        })
      ),
      listAccounts().catch((err: unknown) => {
        console.error('[overview] instantly accounts', err instanceof Error ? err.message : err)
        return undefined
      }),
    ])

    if (targets.length && perCampaign.every((p) => !p.daily && !p.totals)) {
      throw new Error('every Instantly analytics call failed')
    }

    const dailies = perCampaign.map((p) => p.daily).filter((d): d is DailyPoint[] => d !== null)
    const sent_7d = seriesOn(dates, 'sent', ...dailies)
    const opportunities = perCampaign.reduce((n, p) => n + (p.totals?.opportunities ?? 0), 0)
    const valued = perCampaign.filter((p) => p.t.valueUsd !== null && (p.totals?.opportunities ?? 0) > 0)
    const opportunities_value_usd = valued.length
      ? valued.reduce((n, p) => n + p.t.valueUsd! * (p.totals?.opportunities ?? 0), 0)
      : null

    const strip = perCampaign.map(({ t, daily, totals }) => stripItem(t, daily, totals, dates, bounces.get(t.id) ?? 0))

    return {
      instantly: {
        configured: true,
        campaign_source,
        sent_today: sent_7d[sent_7d.length - 1] ?? 0,
        sent_7d,
        opportunities,
        opportunities_value_usd,
        opportunities_7d: seriesOn(dates, 'opportunities', ...dailies),
        accounts,
      },
      strip,
    }
  } catch (err) {
    console.error('[overview] instantly', err instanceof Error ? err.message : err)
    const strip = registered.map((t) => idleItem(t, bounces.get(t.id) ?? 0, 'Instantly unreachable'))
    return { instantly: { configured: true, error: 'instantly_unreachable' }, strip }
  }
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
    id: t.id,
    name: t.name,
    sender: 'instantly',
    status: t.status,
    reply_rate: totals?.reply_rate ?? null,
    sent: totals?.sent ?? null,
    replies: totals?.replies ?? null,
    series: daily ? seriesOn(dates, 'sent', daily) : [],
    bounces_24h: b,
    health: campaignHealth({ bounces24h: b, replyRate: totals?.reply_rate ?? null, idleReason: totals ? 'No sends yet' : 'Analytics unavailable' }),
  }
}
