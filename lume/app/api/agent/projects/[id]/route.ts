import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { deleteProject, getProject, listItems, projectConversations, updateProject } from '@/lib/agent/projects'
import { ProjectPatch } from '@/lib/agent/projectModel'
import { removeProjectObjects } from '@/lib/agent/projectStorage'
import { badId, checkVertical, notFound, projectErrorResponse } from '@/lib/agent/projectHttp'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * One project.
 *  GET    → `{ project, items, conversations }` (items without their text).
 *  PATCH  `{ name?, instructions?, vertical_id? }` → `{ project }` (the
 *         instructions editor autosaves through this); 409 on a taken name
 *         or vertical.
 *  DELETE → its files and notes are removed (rows and Storage objects); its
 *         chats move to Unfiled, never deleted.
 */
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  try {
    const project = await getProject(id)
    if (!project) return notFound()
    const [items, conversations] = await Promise.all([listItems(id), projectConversations(id)])
    return NextResponse.json({ project, items, conversations })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects/[id]')
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, ProjectPatch, 16 * 1024)
  if (!body.ok) return body.response
  try {
    const bad = await checkVertical(body.data.vertical_id)
    if (bad) return bad
    const project = await updateProject(id, body.data)
    if (!project) return notFound()
    return NextResponse.json({ project })
  } catch (err) {
    return projectErrorResponse(err, 'api/agent/projects/[id]')
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  try {
    const paths = await deleteProject(id)
    if (!paths) return notFound()
    await removeProjectObjects(paths)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects/[id]')
  }
}
