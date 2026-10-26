import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getAnalyticsOverview, getDailyAnalytics, getStepAnalytics, isInstantlyConfigured } from '@/lib/adapters/instantly'
import { lastNDates } from '@/lib/adapters/instantly.map'
import { campaignIdParam } from '@/lib/campaigns/params'
import type { CampaignAnalyticsResponse } from '@/lib/campaigns/types'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'

/** One Instantly campaign: totals, daily series (`?days=7|30`, default 7) and per-step totals. Cached 60 s. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = campaignIdParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_campaign_id' }, { status: 400 })
  if (!isInstantlyConfigured()) return notConfigured()

  const days = new URL(req.url).searchParams.get('days') === '30' ? 30 : 7
  const dates = lastNDates(new Date(), days)
  try {
    const [overview, daily, steps] = await Promise.all([
      getAnalyticsOverview(id),
      getDailyAnalytics({ campaignId: id, startDate: dates[0], endDate: dates[dates.length - 1] }),
      getStepAnalytics(id),
    ])
    const body: CampaignAnalyticsResponse = { configured: true, campaign_id: id, days, overview, daily, steps }
    return NextResponse.json(body)
  } catch (err) {
    return instantlyErrorResponse(err, 'api/campaigns/[id]/analytics')
  }
}
