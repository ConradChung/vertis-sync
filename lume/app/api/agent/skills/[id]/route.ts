import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { skillPatchSchema } from '@/lib/agent/skillModel'
import { archiveSkill, DuplicateSkillNameError, getSkill, updateSkill } from '@/lib/agent/skills'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * One saved skill (owner session only).
 *  GET    → `{ skill }` (404 when missing or deleted).
 *  PATCH  → `{ name?, description? }`; 409 on a duplicate name.
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
    const skill = await getSkill(id)
    return skill ? NextResponse.json({ skill }) : notFound()
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/skills/[id]')
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, skillPatchSchema)
  if (!body.ok) return body.response
  try {
    const skill = await updateSkill(id, body.data)
    return skill ? NextResponse.json({ skill }) : notFound()
  } catch (err) {
    if (err instanceof DuplicateSkillNameError) return NextResponse.json({ error: 'duplicate_name' }, { status: 409 })
    return dbErrorResponse(err, 'api/agent/skills/[id]')
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  try {
    return (await archiveSkill(id)) ? NextResponse.json({ ok: true }) : notFound()
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/skills/[id]')
  }
}
