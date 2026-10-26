import { NextResponse } from 'next/server'
import { dbErrorResponse } from '@/lib/http/errors'
import { withSet, type SetCtx } from '@/lib/review/http'
import { keptApolloCsv } from '@/lib/review/export'
import { loadRows } from '@/lib/review/store'

/**
 * `GET /api/review-sets/<id>/export` — the KEPT rows as an Apollo-import CSV
 * (download). Generated on request, so it always matches the current filters.
 */
export async function GET(req: Request, ctx: SetCtx) {
  try {
    const r = await withSet(req, ctx)
    if (!r.ok) return r.response
    const { csv, rows } = keptApolloCsv(await loadRows(r.set.id))
    if (!rows) return NextResponse.json({ error: 'nothing_kept' }, { status: 422 })
    const name = `apollo-${r.set.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'leads'}-${rows}.csv`
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/review-sets/[id]/export')
  }
}
