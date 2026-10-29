import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { createProject, listProjects } from '@/lib/agent/projects'
import { canUseProject, NewProject } from '@/lib/agent/projectModel'
import { checkLink, checkVertical, projectErrorResponse, projectScope } from '@/lib/agent/projectHttp'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * Agent projects (owner session, a Grok Bot on it, or the internal bearer).
 *  GET  → `{ projects }` in sidebar order, each with item_count + total_bytes.
 *  POST `{ name, instructions?, vertical_id? }` → 201 `{ project }`;
 *       409 name_taken / vertical_taken; 400 vertical_not_found.
 * A vertical Grok Bot sees and links only its own vertical's project and
 * unlinked ones (403 forbidden_project); see lib/agent/projectHttp.ts.
 */

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const scope = await projectScope(req, auth)
    return NextResponse.json({ projects: (await listProjects()).filter((p) => canUseProject(scope, p)) })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, NewProject, 16 * 1024)
  if (!body.ok) return body.response
  try {
    const denied = checkLink(await projectScope(req, auth), body.data.vertical_id)
    if (denied) return denied
    const bad = await checkVertical(body.data.vertical_id)
    if (bad) return bad
    return NextResponse.json({ project: await createProject(body.data) }, { status: 201 })
  } catch (err) {
    return projectErrorResponse(err, 'api/agent/projects')
  }
}
