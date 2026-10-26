import 'server-only'
import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { uuidParam } from '@/lib/http/json'
import { getReviewSet, type ReviewSet } from '@/lib/review/store'

export type SetCtx = { params: Promise<{ id: string }> }

/** Owner (session or the agent's internal bearer) + an existing review set, or the error response. */
export async function withSet(req: Request, ctx: SetCtx): Promise<{ ok: true; set: ReviewSet } | { ok: false; response: NextResponse }> {
  const auth = await requireOwner(req)
  if (!auth.ok) return { ok: false, response: auth.response }
  const id = uuidParam((await ctx.params).id)
  if (!id) return { ok: false, response: NextResponse.json({ error: 'invalid_id' }, { status: 400 }) }
  const set = await getReviewSet(id)
  if (!set) return { ok: false, response: NextResponse.json({ error: 'not_found' }, { status: 404 }) }
  return { ok: true, set }
}
