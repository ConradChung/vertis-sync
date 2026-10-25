import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getCampaigns, getQueuedCounts } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { rotatorCampaignId } from '@/lib/rules/rotator'

/**
 * `lume_campaigns` rows, each with `queued` (lead_bank rows waiting for that
 * campaign) and `rotator` (true for the one campaign the existing
 * `instantly-rotate` cron drains; every other campaign's queue just waits).
 * Instantly analytics are merged in by Task 13.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const campaigns = await getCampaigns()
    const queued = await getQueuedCounts(campaigns.map((c) => c.external_id ?? ''))
    const rotator = rotatorCampaignId()
    return NextResponse.json(
      campaigns.map((c) => ({
        ...c,
        queued: c.external_id ? (queued[c.external_id] ?? 0) : 0,
        rotator: c.external_id === rotator,
      }))
    )
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns')
  }
}
