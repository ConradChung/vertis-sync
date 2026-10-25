import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured, listCampaignDetails } from '@/lib/adapters/instantly'
import { logEvent, syncInstantlyCampaigns } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'

/**
 * Instantly `GET /campaigns` (read-only, all pages, deleted dropped) →
 * upsert `lume_campaigns` on (sender_type='instantly', external_id).
 * Name, status, `capacity_per_day` (= campaign `daily_limit`) and
 * `instantly {status, daily_limit, accounts}` are refreshed; the family the
 * owner set is kept, new campaigns land as 'other'. Gmail/Muse rows are
 * untouched. Never writes to Instantly.
 */
export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  if (!isInstantlyConfigured()) return notConfigured()

  let campaigns
  try {
    campaigns = await listCampaignDetails()
  } catch (err) {
    return instantlyErrorResponse(err, 'api/campaigns/sync')
  }
  try {
    const result = await syncInstantlyCampaigns(campaigns, new Date().toISOString())
    await logEvent({
      type: 'lume.campaigns_synced',
      source: 'lume',
      title: `Instantly campaigns synced (${result.inserted} new, ${result.updated} updated)`,
      payload: result,
    }).catch(() => null)
    return NextResponse.json({ configured: true, ok: true, ...result, total: campaigns.length })
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns/sync')
  }
}
