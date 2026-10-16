import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getAnalyticsOverview, getDailyAnalytics, isInstantlyConfigured } from '@/lib/adapters/instantly'
import { lastNDates } from '@/lib/adapters/instantly.map'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'

/**
 * Analytics totals + daily series. `?campaign_id=` narrows to one campaign
 * (else the whole workspace); `?days=` (1–90, default 7) sets the daily window
 * in UTC dates ending today. Cached 60 s.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  if (!isInstantlyConfigured()) return notConfigured()

  const url = new URL(req.url)
  const campaignId = url.searchParams.get('campaign_id') || undefined
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90)
  const dates = lastNDates(new Date(), days)
  try {
    const [overview, daily] = await Promise.all([
      getAnalyticsOverview(campaignId),
      getDailyAnalytics({ campaignId, startDate: dates[0], endDate: dates[dates.length - 1] }),
    ])
    return NextResponse.json({ configured: true, campaign_id: campaignId ?? null, overview, daily })
  } catch (err) {
    return instantlyErrorResponse(err, 'api/instantly/analytics')
  }
}
