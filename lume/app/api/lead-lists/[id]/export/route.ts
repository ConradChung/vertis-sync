import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { csvChunks } from '@/lib/leads/lists/store'
import { withList, type ListCtx } from '@/lib/leads/lists/service'

/**
 * `GET /api/lead-lists/<id>/export` — every row as CSV (download), streamed
 * page by page so a 20k list is never held in memory. Cells go through the
 * formula-safe writer (lib/csv/cell.ts).
 */
export async function GET(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    const chunks = csvChunks(r.list.id)
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await chunks.next()
          if (next.done) controller.close()
          else controller.enqueue(enc.encode(next.value))
        } catch (err) {
          controller.error(err)
        }
      },
    })
    const name = `${r.list.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'leads'}.csv`
    return new Response(stream, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]/export')
  }
}
