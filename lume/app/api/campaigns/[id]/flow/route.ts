import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getAnalyticsOverview, isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { buildBankStage, buildFeeders, buildStages, sumCounts } from '@/lib/campaigns/flow'
import { campaignIdParam } from '@/lib/campaigns/params'
import { getCampaignJobs, getCampaignRules, getLeadSources } from '@/lib/campaigns/service'
import type { CampaignFlowResponse, InstantlyState } from '@/lib/campaigns/types'
import { getGatesForTargets } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'

/**
 * Flow for one campaign. Main path: `validation_jobs where
 * instantly_campaign_id = id` (rows loaded, valid, enriched, pushed) and the
 * open gates on those jobs, then Instantly sent / replies + status. Branch:
 * the campaign's lead bank and what feeds it into Instantly (rotation rules,
 * the instantly-rotate pg_cron jobs and their rotation_runs log). Instantly
 * failing only nulls its part; the branch failing only empties the branch.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = campaignIdParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_campaign_id' }, { status: 400 })

  try {
    let instantly: InstantlyState = isInstantlyConfigured() ? 'ok' : 'not_configured'
    // DB and Instantly in one round: Instantly failing only nulls its part.
    const instantlyPart =
      instantly === 'ok'
        ? Promise.all([getAnalyticsOverview(id), listCampaigns()]).catch((err) => {
            console.error('[api/campaigns/[id]/flow] instantly:', err instanceof Error ? err.message : err)
            instantly = 'error'
            return null
          })
        : Promise.resolve(null)
    const [jobs, sources, rules, live] = await Promise.all([
      getCampaignJobs(id),
      getLeadSources(id).catch((err) => {
        console.error('[api/campaigns/[id]/flow] lead sources:', err instanceof Error ? err.message : err)
        return null
      }),
      getCampaignRules(id).catch(() => []),
      instantlyPart,
    ])
    const gates = await getGatesForTargets(jobs.map((j) => j.id))

    let totals: { sent: number; replies: number } | null = null
    let status: string | null = null
    let name: string | null = null
    if (live) {
      const [overview, list] = live
      totals = { sent: overview.sent, replies: overview.replies }
      const c = list.find((x) => x.id === id)
      status = c?.statusLabel ?? null
      name = c?.name ?? null
    }

    const counts = sumCounts(jobs, totals, sources)
    const body: CampaignFlowResponse = {
      campaign_id: id,
      instantly,
      campaign_status: status,
      campaign_name: name ?? jobs.find((j) => j.filename)?.filename ?? null,
      counts,
      jobs,
      gates,
      stages: buildStages({ counts, gates, jobs, campaignStatus: status }),
      bank: buildBankStage(counts, sources),
      feeders: buildFeeders(rules, sources),
    }
    return NextResponse.json(body)
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns/[id]/flow')
  }
}
