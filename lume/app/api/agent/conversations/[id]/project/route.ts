import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getProject, moveConversation } from '@/lib/agent/projects'
import { MoveConversation } from '@/lib/agent/projectModel'
import { badId, notFound } from '@/lib/agent/projectHttp'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * PUT `{ project_id }` files a conversation in a project; `null` moves it to
 * Unfiled (sidebar drag-and-drop and the "Move to project" menu).
 * 404 project_not_found / not_found.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, MoveConversation, 1024)
  if (!body.ok) return body.response
  const projectId = body.data.project_id?.toLowerCase() ?? null
  try {
    if (projectId && !(await getProject(projectId))) return notFound('project_not_found')
    if (!(await moveConversation(id, projectId))) return notFound()
    return NextResponse.json({ ok: true, project_id: projectId })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/conversations/[id]/project')
  }
}
