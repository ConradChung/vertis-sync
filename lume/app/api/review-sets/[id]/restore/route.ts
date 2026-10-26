import { NextResponse } from 'next/server'
import { z } from 'zod'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { withSet, type SetCtx } from '@/lib/review/http'
import { restore } from '@/lib/review/store'

/** `POST /api/review-sets/<id>/restore` `{ filter_id } | { item_ids } | { all: true }` → `{ restored, after }`. */
const Body = z
  .object({ filter_id: z.string().max(40).optional(), item_ids: z.array(z.number().int().min(0)).max(5000).optional(), all: z.boolean().optional() })
  .refine((b) => !!b.filter_id || !!b.item_ids?.length || b.all === true, 'filter_id, item_ids or all')

export async function POST(req: Request, ctx: SetCtx) {
  try {
    const r = await withSet(req, ctx)
    if (!r.ok) return r.response
    const body = await parseJsonBody(req, Body, 64 * 1024)
    if (!body.ok) return body.response
    return NextResponse.json(await restore(r.set, body.data))
  } catch (err) {
    return dbErrorResponse(err, 'api/review-sets/[id]/restore')
  }
}
