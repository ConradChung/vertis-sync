import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { getJobRows, logEvent, updatePendingRow } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, UUID_RE, uuidParam } from '@/lib/http/json'

/**
 * Per-lead rows of a validation job.
 *   GET   ?page=0 → 100 rows, `order=row_index`
 *   PATCH { row_id, email?, row_data_patch? } → only while the job waits at
 *         the finder prompt (409 job_running) and only rows still `pending`
 *         (conditional update; 409 not_pending); `row_data` keys are merged.
 */

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const raw = new URL(req.url).searchParams.get('page') ?? '0'
  const page = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN
  if (!Number.isFinite(page)) return NextResponse.json({ error: 'bad_page' }, { status: 400 })
  try {
    return NextResponse.json(await getJobRows(id, page))
  } catch (err) {
    return dbErrorResponse(err, 'api/jobs/[id]/rows')
  }
}

const PatchBody = z
  .object({
    row_id: z.string().regex(UUID_RE),
    email: z.string().trim().toLowerCase().max(320).pipe(z.email()).optional(),
    row_data_patch: z
      .record(z.string().min(1).max(100), z.string().max(500).nullable())
      .refine((r) => Object.keys(r).length <= 20)
      .optional(),
  })
  .strict()
  .refine((b) => b.email !== undefined || (b.row_data_patch && Object.keys(b.row_data_patch).length > 0))

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const body = await parseJsonBody(req, PatchBody, 16 * 1024)
  if (!body.ok) return body.response
  const rowId = body.data.row_id.toLowerCase()

  let result
  try {
    result = await updatePendingRow(id, rowId, { email: body.data.email, row_data_patch: body.data.row_data_patch })
  } catch (err) {
    return dbErrorResponse(err, 'api/jobs/[id]/rows')
  }
  if (!result.ok) {
    return result.reason === 'not_found'
      ? NextResponse.json({ error: 'not_found' }, { status: 404 })
      : NextResponse.json({ error: result.reason }, { status: 409 })
  }

  try {
    // No email value in the title or payload: the feed is not a lead store.
    await logEvent({
      type: 'lume.row_edit',
      source: 'lume',
      source_id: rowId,
      title: `Row ${result.row.row_index} edited in Lume`,
      payload: { job_id: id, fields: result.fields, email_changed: result.emailChanged },
    })
  } catch (err) {
    console.error('[api/jobs/[id]/rows] logEvent failed:', err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ ok: true, row: result.row })
}
