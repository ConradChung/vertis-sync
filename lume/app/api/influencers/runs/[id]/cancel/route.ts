import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { uuidParam } from '@/lib/http/json'
import { callInfluencerFn } from '@/lib/adapters/influencerFn'

/**
 * `POST /api/influencers/runs/<id>/cancel` → cancels a running or awaiting
 * run and aborts its live Apify runs. Only stops spending; 409 when the run
 * is not active.
 */
type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  const r = await callInfluencerFn({ action: 'cancel', run_id: id })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status === 409 ? 409 : 502 })
  return NextResponse.json(r.body)
}
