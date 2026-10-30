import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { ApifyError } from '@/lib/adapters/apify'
import { DATASET_ID_RE, JOB_ID_RE, SourceError } from '@/lib/apollo/source'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { summarise } from '@/lib/review/model'
import { createReviewSet, createReviewSetFromRows, listReviewSets, loadRows } from '@/lib/review/store'
import { loadAttachmentLeads } from '@/lib/review/attachmentSource'
import { fileInConversation } from '@/lib/agent/chatFiles'
import { LEAD_FIELDS } from '@/lib/review/columns'

/**
 * Lead review sets (owner, or the agent's bearer).
 *  GET  ?conversation=<id> → `{ sets }` newest first.
 *  POST `{ source: {kind:'run'|'dataset'|'job', id}, conversation_id?, title? }` →
 *       copies the results (≤ 5 000) into a new set → `{ set, summary, truncated }`.
 *       `{ kind:'attachment', id: <file id>, sheet?, columns? }` reads one sheet of
 *       an attached spreadsheet (with `conversation_id`, the file must be
 *       attached in that chat: 404 otherwise); the column mapping (detected,
 *       `columns` overrides win: field → header) comes back as
 *       `column_mapping` with the `unmapped_columns`, which stay in each row's raw.
 */
export const maxDuration = 120

const Body = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('run'), id: z.string().regex(DATASET_ID_RE) }),
    z.object({ kind: z.literal('dataset'), id: z.string().regex(DATASET_ID_RE) }),
    z.object({ kind: z.literal('job'), id: z.string().regex(JOB_ID_RE) }),
    z.object({
      kind: z.literal('attachment'),
      id: z.string().uuid(),
      sheet: z.string().max(200).optional(),
      columns: z.partialRecord(z.enum(LEAD_FIELDS), z.string().max(200)).optional(),
    }),
  ]),
  conversation_id: z.string().uuid().nullable().optional(),
  title: z.string().max(200).optional(),
})

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const conv = new URL(req.url).searchParams.get('conversation')
  const conversationId = conv ? uuidParam(conv) : null
  if (conv && !conversationId) return NextResponse.json({ error: 'invalid_conversation' }, { status: 400 })
  try {
    return NextResponse.json({ sets: await listReviewSets(conversationId) })
  } catch (err) {
    return dbErrorResponse(err, 'api/review-sets')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  try {
    const src = body.data.source
    const opts = { conversationId: body.data.conversation_id ?? null, title: body.data.title }
    if (src.kind === 'attachment') {
      const fileId = src.id.toLowerCase()
      if (opts.conversationId && !(await fileInConversation(fileId, opts.conversationId))) return NextResponse.json({ error: 'file_not_found' }, { status: 404 })
      const sheet = await loadAttachmentLeads(fileId, src.sheet, src.columns ?? {})
      const { set, truncated, source_rows } = await createReviewSetFromRows(sheet, opts)
      return NextResponse.json(
        { set, truncated, source_rows, sheet: sheet.sheet, column_mapping: sheet.mapping, unmapped_columns: sheet.unmapped, summary: summarise(await loadRows(set.id)) },
        { status: 201 }
      )
    }
    const { set, truncated, source_rows } = await createReviewSet(src, opts)
    return NextResponse.json({ set, truncated, source_rows, summary: summarise(await loadRows(set.id)) }, { status: 201 })
  } catch (err) {
    if (err instanceof SourceError) return NextResponse.json({ error: err.code }, { status: err.status })
    if (err instanceof ApifyError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'not_configured' ? 503 : 502
      return NextResponse.json({ error: `apify_${err.code}` }, { status })
    }
    return dbErrorResponse(err, 'api/review-sets')
  }
}
