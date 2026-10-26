import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured, listCampaignThreads } from '@/lib/adapters/instantly'
import { campaignIdParam } from '@/lib/campaigns/params'
import type { CampaignInboxResponse } from '@/lib/campaigns/types'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'

/**
 * Instantly `GET /emails?campaign_id=` (newest 100) grouped into threads.
 * Read-only: a reply is a `send_reply` pending action via `POST /api/actions`.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = campaignIdParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_campaign_id' }, { status: 400 })
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    const body: CampaignInboxResponse = { configured: true, campaign_id: id, threads: await listCampaignThreads(id) }
    return NextResponse.json(body)
  } catch (err) {
    return instantlyErrorResponse(err, 'api/campaigns/[id]/inbox')
  }
}
