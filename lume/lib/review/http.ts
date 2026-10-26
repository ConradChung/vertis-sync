import 'server-only'
import { NextResponse } from 'next/server'
import { uuidParam } from '@/lib/http/json'
import { getReviewSet, type ReviewSet } from '@/lib/review/store'

export type SetCtx = { params: Promise<{ id: string }> }

/** An existing review set from the route params, or the error response (call after the owner guard). */
export async function withSet(ctx: SetCtx): Promise<{ ok: true; set: ReviewSet } | { ok: false; response: NextResponse }> {
  const id = uuidParam((await ctx.params).id)
  if (!id) return { ok: false, response: NextResponse.json({ error: 'invalid_id' }, { status: 400 }) }
  const set = await getReviewSet(id)
  if (!set) return { ok: false, response: NextResponse.json({ error: 'not_found' }, { status: 404 }) }
  return { ok: true, set }
}
