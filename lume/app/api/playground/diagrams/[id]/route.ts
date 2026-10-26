import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { archiveDiagram, getDiagram, renameDiagram } from '@/lib/playground/diagrams'
import { diagramPatchSchema } from '@/lib/playground/model'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * One saved diagram (owner session only).
 *  GET    → `{ diagram }` (404 when missing or deleted).
 *  PATCH  → `{ title }` rename.
 *  DELETE → soft delete (`archived_at`).
 */
type Ctx = { params: Promise<{ id: string }> }

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 })
const badId = () => NextResponse.json({ error: 'invalid_id' }, { status: 400 })

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  try {
    const diagram = await getDiagram(id)
    return diagram ? NextResponse.json({ diagram }) : notFound()
  } catch (err) {
    return dbErrorResponse(err, 'api/playground/diagrams/[id]')
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, diagramPatchSchema)
  if (!body.ok) return body.response
  try {
    const diagram = await renameDiagram(id, body.data.title)
    return diagram ? NextResponse.json({ diagram }) : notFound()
  } catch (err) {
    return dbErrorResponse(err, 'api/playground/diagrams/[id]')
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  try {
    return (await archiveDiagram(id)) ? NextResponse.json({ ok: true }) : notFound()
  } catch (err) {
    return dbErrorResponse(err, 'api/playground/diagrams/[id]')
  }
}
