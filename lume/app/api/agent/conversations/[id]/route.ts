import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { getActionStatuses } from '@/lib/actions/store'
import { archiveConversation, getConversation, getMessages, renameConversation } from '@/lib/agent/conversations'
import type { StoredMessage } from '@/lib/agent/history'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * One Agent conversation (owner session only).
 *  GET    → `{ conversation, messages }` (404 when missing or deleted); each
 *           approval carries its action's live `status` so a reload shows
 *           whether it was since approved, run or denied.
 *  PATCH  → `{ title }` rename.
 *  DELETE → soft delete (`archived_at`); the rows stay for the run log.
 */
type Ctx = { params: Promise<{ id: string }> }

const Rename = z.object({ title: z.string().trim().min(1).max(120) }).strict()

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 })
const badId = () => NextResponse.json({ error: 'invalid_id' }, { status: 400 })

/** One `in` query for every approval's row status; null when the row is gone. A failed lookup leaves them unset. */
async function withLiveStatus(messages: StoredMessage[]): Promise<StoredMessage[]> {
  const ids = messages.flatMap((m) => (m.approvals ?? []).map((a) => a.action_id))
  if (!ids.length) return messages
  let statuses: Map<string, string>
  try {
    statuses = await getActionStatuses(ids)
  } catch (err) {
    // The cards fall back to their stored state; the chat itself still loads.
    console.error('[api/agent/conversations/[id]] status lookup failed:', err instanceof Error ? err.message : err)
    return messages
  }
  return messages.map((m) =>
    m.approvals?.length ? { ...m, approvals: m.approvals.map((a) => ({ ...a, status: statuses.get(a.action_id) ?? null })) } : m
  )
}

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  try {
    const conversation = await getConversation(id)
    if (!conversation) return notFound()
    return NextResponse.json({ conversation, messages: await withLiveStatus(await getMessages(id)) })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/conversations/[id]')
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, Rename)
  if (!body.ok) return body.response
  try {
    if (!(await renameConversation(id, body.data.title))) return notFound()
    return NextResponse.json({ ok: true, title: body.data.title })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/conversations/[id]')
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  try {
    if (!(await archiveConversation(id))) return notFound()
    return NextResponse.json({ ok: true })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/conversations/[id]')
  }
}
