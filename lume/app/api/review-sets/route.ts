import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { ApifyError } from '@/lib/adapters/apify'
import { DATASET_ID_RE, JOB_ID_RE, SourceError } from '@/lib/apollo/source'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { summarise } from '@/lib/review/model'
import { createReviewSet, listReviewSets, loadRows } from '@/lib/review/store'

/**
 * Lead review sets (owner, or the agent's bearer).
 *  GET  ?conversation=<id> → `{ sets }` newest first.
 *  POST `{ source: {kind:'run'|'dataset'|'job', id}, conversation_id?, title? }` →
 *       copies the results (≤ 5 000) into a new set → `{ set, summary, truncated }`.
 */
export const maxDuration = 120

const Body = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('run'), id: z.string().regex(DATASET_ID_RE) }),
    z.object({ kind: z.literal('dataset'), id: z.string().regex(DATASET_ID_RE) }),
    z.object({ kind: z.literal('job'), id: z.string().regex(JOB_ID_RE) }),
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
    const { set, truncated, source_rows } = await createReviewSet(body.data.source, {
      conversationId: body.data.conversation_id ?? null,
      title: body.data.title,
    })
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
