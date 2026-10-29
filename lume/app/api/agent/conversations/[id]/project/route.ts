import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getConversation } from '@/lib/agent/conversations'
import { getProject, moveConversation } from '@/lib/agent/projects'
import { canUseProject, MoveConversation } from '@/lib/agent/projectModel'
import { badId, forbidden, notFound, projectErrorResponse, projectScope, requireProject } from '@/lib/agent/projectHttp'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * PUT `{ project_id }` files a conversation in a project; `null` moves it to
 * Unfiled (sidebar drag-and-drop and the "Move to project" menu).
 * 404 project_not_found (also when the project is deleted mid-move) /
 * not_found. A vertical Grok Bot can neither move a chat into another
 * vertical's project nor take one out of it (403 forbidden_project).
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
    const scope = await projectScope(req, auth)
    if (projectId) {
      const found = await requireProject(projectId, scope)
      if ('response' in found) return found.response.status === 404 ? notFound('project_not_found') : found.response
    }
    if (scope) {
      const conversation = await getConversation(id)
      if (!conversation) return notFound()
      const from = conversation.project_id ? await getProject(conversation.project_id) : null
      if (from && !canUseProject(scope, from)) return forbidden()
    }
    if (!(await moveConversation(id, projectId))) return notFound()
    return NextResponse.json({ ok: true, project_id: projectId })
  } catch (err) {
    return projectErrorResponse(err, 'api/agent/conversations/[id]/project')
  }
}
