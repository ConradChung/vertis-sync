import { NextResponse } from 'next/server'
import { z } from 'zod'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { withSet, type SetCtx } from '@/lib/review/http'
import { setRowsByHand } from '@/lib/review/store'

/** `POST /api/review-sets/<id>/rows` `{ idxs, status }` — hand edits from the Leads table. */
const Body = z.object({ idxs: z.array(z.number().int().min(0)).min(1).max(5000), status: z.enum(['kept', 'excluded']) })

export async function POST(req: Request, ctx: SetCtx) {
  try {
    const r = await withSet(req, ctx)
    if (!r.ok) return r.response
    const body = await parseJsonBody(req, Body, 64 * 1024)
    if (!body.ok) return body.response
    return NextResponse.json(await setRowsByHand(r.set, body.data.idxs, body.data.status))
  } catch (err) {
    return dbErrorResponse(err, 'api/review-sets/[id]/rows')
  }
}
