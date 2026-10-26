import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getAnalyticsOverview, isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { buildStages, sumCounts } from '@/lib/campaigns/flow'
import { campaignIdParam } from '@/lib/campaigns/params'
import { getCampaignJobs } from '@/lib/campaigns/service'
import type { CampaignFlowResponse, InstantlyState } from '@/lib/campaigns/types'
import { getGatesForTargets } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'

/**
 * Flow counts for one campaign: `validation_jobs where instantly_campaign_id
 * = id` (rows loaded, valid, enriched, pushed), open gates on those jobs, and
 * Instantly sent / replies + status. Instantly failing only nulls its part.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = campaignIdParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_campaign_id' }, { status: 400 })

  try {
    const jobs = await getCampaignJobs(id)
    const gates = await getGatesForTargets(jobs.map((j) => j.id))

    let instantly: InstantlyState = isInstantlyConfigured() ? 'ok' : 'not_configured'
    let totals: { sent: number; replies: number } | null = null
    let status: string | null = null
    let name: string | null = null
    if (instantly === 'ok') {
      try {
        const [overview, list] = await Promise.all([getAnalyticsOverview(id), listCampaigns()])
        totals = { sent: overview.sent, replies: overview.replies }
        const c = list.find((x) => x.id === id)
        status = c?.statusLabel ?? null
        name = c?.name ?? null
      } catch (err) {
        console.error('[api/campaigns/[id]/flow] instantly:', err instanceof Error ? err.message : err)
        instantly = 'error'
      }
    }

    const counts = sumCounts(jobs, totals)
    const body: CampaignFlowResponse = {
      campaign_id: id,
      instantly,
      campaign_status: status,
      campaign_name: name ?? jobs.find((j) => j.filename)?.filename ?? null,
      counts,
      jobs,
      gates,
      stages: buildStages({ counts, gates, jobs, campaignStatus: status }),
    }
    return NextResponse.json(body)
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns/[id]/flow')
  }
}
