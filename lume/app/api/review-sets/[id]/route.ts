import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { withSet, type SetCtx } from '@/lib/review/http'
import { summarise } from '@/lib/review/model'
import { loadRows } from '@/lib/review/store'

/** `GET /api/review-sets/<id>` → `{ set, summary }` (summary over kept rows, plus totals). */
export async function GET(req: Request, ctx: SetCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const r = await withSet(ctx)
    if (!r.ok) return r.response
    return NextResponse.json({ set: r.set, summary: summarise(await loadRows(r.set.id)) })
  } catch (err) {
    return dbErrorResponse(err, 'api/review-sets/[id]')
  }
}
