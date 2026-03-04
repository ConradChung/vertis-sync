import { NextRequest, NextResponse } from 'next/server'

const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY!
const INSTANTLY_BASE_URL = 'https://api.instantly.ai/api/v2'
const headers = { Authorization: `Bearer ${INSTANTLY_API_KEY}` }

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const campaignId = request.nextUrl.searchParams.get('campaign_id')
  if (!campaignId) {
    return NextResponse.json({ error: 'campaign_id required' }, { status: 400 })
  }

  const [overviewRes, stepsRes] = await Promise.all([
    fetch(`${INSTANTLY_BASE_URL}/campaigns/analytics/overview?id=${campaignId}`, { headers, cache: 'no-store' }),
    fetch(`${INSTANTLY_BASE_URL}/campaigns/analytics/steps?campaign_id=${campaignId}`, { headers, cache: 'no-store' }),
  ])

  const [overview, steps] = await Promise.all([overviewRes.json(), stepsRes.json()])

  return NextResponse.json({ overview, steps }, { headers: { 'Cache-Control': 'no-store' } })
}
