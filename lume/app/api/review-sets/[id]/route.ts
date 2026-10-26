import { NextResponse } from 'next/server'
import { dbErrorResponse } from '@/lib/http/errors'
import { withSet, type SetCtx } from '@/lib/review/http'
import { summarise } from '@/lib/review/model'
import { loadRows } from '@/lib/review/store'

/** `GET /api/review-sets/<id>` → `{ set, summary }` (summary over kept rows, plus totals). */
export async function GET(req: Request, ctx: SetCtx) {
  try {
    const r = await withSet(req, ctx)
    if (!r.ok) return r.response
    return NextResponse.json({ set: r.set, summary: summarise(await loadRows(r.set.id)) })
  } catch (err) {
    return dbErrorResponse(err, 'api/review-sets/[id]')
  }
}
