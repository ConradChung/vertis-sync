import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { getPreviewJob, previewCsvChunks } from '@/lib/validate/previewStore'

/**
 * `GET /api/validation-jobs/<id>/export?status=valid|all` — the preview's
 * columns as a CSV download (original columns, Status, Reason, enrichment),
 * streamed 1,000 rows at a time. Cells go through the formula-safe writer.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const raw = new URL(req.url).searchParams.get('status') ?? 'valid'
  if (raw !== 'valid' && raw !== 'all') return NextResponse.json({ error: 'bad_status' }, { status: 400 })
  try {
    const job = await getPreviewJob(id)
    if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const chunks = previewCsvChunks(job, raw)
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
    const base = job.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'leads'
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}-${raw}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/validation-jobs/[id]/export')
  }
}
