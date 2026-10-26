import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { archiveConversation, getConversation, getMessages, renameConversation } from '@/lib/agent/conversations'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * One Agent conversation (owner session only).
 *  GET    → `{ conversation, messages }` (404 when missing or deleted).
 *  PATCH  → `{ title }` rename.
 *  DELETE → soft delete (`archived_at`); the rows stay for the run log.
 */
type Ctx = { params: Promise<{ id: string }> }

const Rename = z.object({ title: z.string().trim().min(1).max(120) }).strict()

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 })
const badId = () => NextResponse.json({ error: 'invalid_id' }, { status: 400 })

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  try {
    const conversation = await getConversation(id)
    if (!conversation) return notFound()
    return NextResponse.json({ conversation, messages: await getMessages(id) })
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
