import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { estimateInfluencer, LAST_RUN } from '@/lib/influencers/model'
import { NewInfluencerBody, slugFromName } from '@/lib/influencers/schemas'
import { DuplicateInfluencerError, insertInfluencer, listInfluencers, listRuns } from '@/lib/influencers/store'

/**
 * PM influencer reactions: the influencers.
 *   GET  → `{ influencers, runs, benchmarks }`: each influencer with its last
 *          run's yield and cost (and zero_yield / warning), the 3 newest runs,
 *          the 2026-10-08 full-run benchmarks.
 *   POST `{ name, linkedin_url, slug?, lookback_days?, max_reactions_per_post?, notes? }`
 *          → 201 `{ influencer }`; 409 duplicate. Inert (nothing runs).
 * Owner (session or the agent's internal bearer).
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const [rows, runs] = await Promise.all([listInfluencers(), listRuns(3)])
    return NextResponse.json({
      influencers: rows.map((r) => {
        const e = estimateInfluencer(r)
        return { ...r, zero_yield: e.zero_yield, warning: e.warning }
      }),
      runs: runs.map((r) => ({ id: r.id, status: r.status, stage: r.stage, influencers: r.influencer_ids.length, counts: r.counts, cost: r.cost, created_at: r.created_at, finished_at: r.finished_at })),
      benchmarks: LAST_RUN,
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, NewInfluencerBody, 8 * 1024)
  if (!body.ok) return body.response
  const slug = body.data.slug ?? slugFromName(body.data.name)
  if (!slug) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  try {
    const influencer = await insertInfluencer({ ...body.data, slug, notes: body.data.notes ?? null })
    return NextResponse.json({ influencer }, { status: 201 })
  } catch (err) {
    if (err instanceof DuplicateInfluencerError) return NextResponse.json({ error: 'duplicate' }, { status: 409 })
    return dbErrorResponse(err, 'api/influencers')
  }
}
