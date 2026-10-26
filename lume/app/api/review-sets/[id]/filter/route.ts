import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { z } from 'zod'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { withSet, type SetCtx } from '@/lib/review/http'
import { FilterCriteria } from '@/lib/review/model'
import { applyFilter } from '@/lib/review/store'

/**
 * `POST /api/review-sets/<id>/filter` `{ action: 'exclude'|'keep_only', criteria, reason? }`
 * → `{ filter, before, after, sample }`. Reversible with /restore.
 */
const Body = z.object({ action: z.enum(['exclude', 'keep_only']), criteria: FilterCriteria, reason: z.string().max(300).optional() })

export async function POST(req: Request, ctx: SetCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const r = await withSet(ctx)
    if (!r.ok) return r.response
    const body = await parseJsonBody(req, Body, 64 * 1024)
    if (!body.ok) return body.response
    return NextResponse.json(await applyFilter(r.set, body.data.criteria, body.data.action, body.data.reason ?? null))
  } catch (err) {
    return dbErrorResponse(err, 'api/review-sets/[id]/filter')
  }
}
