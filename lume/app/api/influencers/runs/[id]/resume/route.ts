import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { uuidParam } from '@/lib/http/json'
import { callInfluencerFn } from '@/lib/adapters/influencerFn'

/**
 * `POST /api/influencers/runs/<id>/resume` → continues a FAILED run from the
 * stage it failed in, when that stage starts no Apify scrape (top_posts,
 * triage, verify, doors, output): the paid scrape is never repeated, and
 * spending stays under what the owner already approved for the run
 * (top_posts still stops for the reactions bill). 409 with the reason
 * (not_failed, stage_not_resumable, too_old, run_in_progress) otherwise.
 */
type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  const r = await callInfluencerFn({ action: 'resume', run_id: id })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status === 409 || r.status === 404 ? r.status : 502 })
  return NextResponse.json(r.body)
}
