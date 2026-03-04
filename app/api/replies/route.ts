import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const campaignId = searchParams.get('campaign_id')

  if (!campaignId) {
    return NextResponse.json({ error: 'Campaign ID is required' }, { status: 400 })
  }

  // V2 API does not have a dedicated replies listing endpoint.
  // Reply analytics are included in the main analytics endpoint.
  return NextResponse.json([])
}
