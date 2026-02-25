import { NextRequest, NextResponse } from 'next/server'
import { getRecentReplies } from '@/lib/instantly'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const campaignId = searchParams.get('campaign_id')

  if (!campaignId) {
    return NextResponse.json({ error: 'Campaign ID is required' }, { status: 400 })
  }

  try {
    const replies = await getRecentReplies(campaignId, 10)
    return NextResponse.json(replies)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
