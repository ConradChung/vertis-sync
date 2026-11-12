import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { parsePreviewQuery } from '@/lib/validate/preview'
import { getPreviewPage } from '@/lib/validate/previewStore'

/**
 * `GET /api/validation-jobs/<id>/rows?page=0&status=valid|invalid|error|all&send=sending|pulled|all&q=`
 * → one page (100) of the validated-leads preview: the original CSV columns
 * in `column_order` order, Status + MailTester reason, enrichment columns;
 * counts per status and per sending tab (lead bank state); `row_index` order. `q` matches the email or any
 * original value (escaped ILIKE through a parameterised RPC). Read-only.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const parsed = parsePreviewQuery(new URL(req.url).searchParams)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  try {
    const page = await getPreviewPage(id, parsed.query)
    if (!page) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json(page)
  } catch (err) {
    return dbErrorResponse(err, 'api/validation-jobs/[id]/rows')
  }
}
