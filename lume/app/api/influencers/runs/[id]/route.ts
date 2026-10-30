import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { apifyMonthSpend, getApifyRuns, getInfluencersByIds, getRun } from '@/lib/influencers/store'
import { MONTHLY_APIFY_CAP_USD } from '@/lib/influencers/model'

/**
 * `GET /api/influencers/runs/<id>` → `{ run, influencers, budget }`: status,
 * stage, counts, estimate and actual cost per vendor; budget names the
 * influencers the shared Apify cap skipped (posts / reactions) and the cap
 * left this month (ledger).
 */
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  try {
    const run = await getRun(id)
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const [infl, apifyRuns, spend] = await Promise.all([getInfluencersByIds(run.influencer_ids), getApifyRuns(id), apifyMonthSpend()])
    const name = (iid: string) => infl.find((i) => i.id === iid)?.name ?? iid
    const skipped = (kind: string) =>
      apifyRuns.filter((a) => a.kind === kind && a.status === 'failed' && (a.error ?? '').startsWith('budget_exceeded')).map((a) => name(a.influencer_id))
    return NextResponse.json({
      run,
      influencers: infl.map((i) => ({ slug: i.slug, name: i.name })),
      budget: {
        posts_budget_skipped: skipped('posts'),
        reactions_budget_skipped: skipped('reactions'),
        apify_month_to_date_ledger_usd: spend,
        monthly_cap_usd: MONTHLY_APIFY_CAP_USD,
        cap_left_usd: spend === null ? null : Math.max(0, Math.round((MONTHLY_APIFY_CAP_USD - spend) * 100) / 100),
      },
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/runs/[id]')
  }
}
