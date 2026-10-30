import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { estimateRun, LAST_RUN, MONTHLY_APIFY_CAP_USD } from '@/lib/influencers/model'
import { MaxVerifyUsd, Slug } from '@/lib/influencers/schemas'
import { apifyMonthSpend, getInfluencersBySlugs, listInfluencers } from '@/lib/influencers/store'

/**
 * `GET /api/influencers/estimate?slugs=a,b[&max_verify_usd=10]` (or no slugs:
 * every active influencer) → the run estimate from each influencer's last-run
 * numbers and the unit prices: posts cost now, reactions and Perplexity
 * ranges, expected leads; plus the shared Apify month-to-date ledger vs the
 * monthly cap. Read-only.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const params = new URL(req.url).searchParams
  const raw = (params.get('slugs') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (raw.length > 100 || !raw.every((s) => Slug.safeParse(s).success)) return NextResponse.json({ error: 'invalid_slugs' }, { status: 400 })
  const cap = MaxVerifyUsd.safeParse(Number(params.get('max_verify_usd') ?? 10))
  if (!cap.success) return NextResponse.json({ error: 'invalid_max_verify_usd' }, { status: 400 })
  try {
    const rows = raw.length ? await getInfluencersBySlugs(raw) : await listInfluencers({ activeOnly: true })
    const unknown = raw.filter((s) => !rows.some((r) => r.slug === s))
    if (unknown.length) return NextResponse.json({ error: 'unknown_influencers', unknown }, { status: 404 })
    const inactive = rows.filter((r) => !r.active).map((r) => r.slug)
    const spend = await apifyMonthSpend()
    return NextResponse.json({
      estimate: estimateRun(rows, { maxVerifyUsd: cap.data }),
      inactive,
      apify_budget: { month_to_date_ledger_usd: spend, monthly_cap_usd: MONTHLY_APIFY_CAP_USD, note: 'Shared with company research; each Apify start is refused if it would pass the cap (Apify account usage + reservations).' },
      benchmarks: LAST_RUN,
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/estimate')
  }
}
