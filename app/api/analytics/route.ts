import { NextRequest, NextResponse } from 'next/server'
import { getCampaignAnalytics, getDailyAnalytics, getStepAnalytics } from '@/lib/instantly'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const campaignId = searchParams.get('campaign_id')

  if (!campaignId) {
    return NextResponse.json({ error: 'Campaign ID is required' }, { status: 400 })
  }

  try {
    const [summary, daily, steps] = await Promise.all([
      getCampaignAnalytics(campaignId),
      getDailyAnalytics(campaignId),
      getStepAnalytics(campaignId),
    ])
    return NextResponse.json({ summary, daily, steps }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
