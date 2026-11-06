import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { AppendSource } from '@/lib/leads/lists/sources'
import { autoAppendToProject, sourceErrorResponse } from '@/lib/leads/lists/service'

/**
 * `POST /api/lead-lists/auto` `{ project_id, source, conversation_id? }` — the
 * agent's auto-append: leads produced in a project's chat go to that
 * project's default list (created the first time, named after the project),
 * with dedupe. 200 `{ appended: null }` when the project is gone.
 */
export const maxDuration = 120

const Body = z.object({ project_id: z.string().uuid(), source: AppendSource, conversation_id: z.string().uuid().nullable().optional() })

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 512 * 1024)
  if (!body.ok) return body.response
  try {
    const appended = await autoAppendToProject(body.data.project_id.toLowerCase(), body.data.source, { conversationId: body.data.conversation_id?.toLowerCase() ?? null })
    return NextResponse.json({ appended })
  } catch (err) {
    return sourceErrorResponse(err) ?? dbErrorResponse(err, 'api/lead-lists/auto')
  }
}
