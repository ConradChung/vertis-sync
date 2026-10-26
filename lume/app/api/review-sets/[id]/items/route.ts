import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { withSet, type SetCtx } from '@/lib/review/http'
import { pageRows } from '@/lib/review/query'
import { loadRows } from '@/lib/review/store'

/**
 * `GET /api/review-sets/<id>/items?status=kept|excluded|all&q=&category=&city=&page=0&page_size=50`
 * → `{ rows, total, page, page_size }`.
 */
export async function GET(req: Request, ctx: SetCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const r = await withSet(ctx)
    if (!r.ok) return r.response
    const p = new URL(req.url).searchParams
    const status = p.get('status')
    return NextResponse.json(
      pageRows(await loadRows(r.set.id), {
        status: status === 'excluded' || status === 'all' ? status : 'kept',
        q: p.get('q') ?? undefined,
        category: p.get('category') ?? undefined,
        city: p.get('city') ?? undefined,
        page: Number(p.get('page')) || 0,
        pageSize: Number(p.get('page_size')) || 50,
      })
    )
  } catch (err) {
    return dbErrorResponse(err, 'api/review-sets/[id]/items')
  }
}
