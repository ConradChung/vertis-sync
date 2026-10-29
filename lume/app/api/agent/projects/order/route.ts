import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { listProjects, reorderProjects } from '@/lib/agent/projects'
import { canUseProject, ProjectOrder } from '@/lib/agent/projectModel'
import { forbidden, projectScope } from '@/lib/agent/projectHttp'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * PUT `{ ids }` → the sidebar order (ids[0] first). `{ ok, updated }`.
 * A vertical Grok Bot may only order projects it can use (403 otherwise).
 */
export async function PUT(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, ProjectOrder, 32 * 1024)
  if (!body.ok) return body.response
  const ids = body.data.ids.map((id) => id.toLowerCase())
  try {
    const scope = await projectScope(req, auth)
    if (scope) {
      const usable = new Set((await listProjects()).filter((p) => canUseProject(scope, p)).map((p) => p.id))
      if (ids.some((id) => !usable.has(id))) return forbidden()
    }
    const updated = await reorderProjects(ids)
    return NextResponse.json({ ok: true, updated })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects/order')
  }
}
