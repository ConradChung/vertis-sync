import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { getInfluencersByIds, getRun } from '@/lib/influencers/store'

/** `GET /api/influencers/runs/<id>` → `{ run, influencers }` (status, stage, counts, estimate and actual cost per vendor). */
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  try {
    const run = await getRun(id)
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const infl = await getInfluencersByIds(run.influencer_ids)
    return NextResponse.json({ run, influencers: infl.map((i) => ({ slug: i.slug, name: i.name })) })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/runs/[id]')
  }
}
