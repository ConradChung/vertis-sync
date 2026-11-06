import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { getProject } from '@/lib/agent/projects'
import { createList } from '@/lib/leads/lists/store'
import { folderTree, leadsHref } from '@/lib/leads/lists/service'

/**
 * Lead lists (owner, or the agent's bearer).
 *  GET  → `{ folders }`: live projects in order, each with its lists, then Unfiled.
 *  POST `{ name, notes?, project_id? }` → 201 `{ list, href }`; created_by is
 *       'agent' for the bearer, 'owner' for the session.
 */
const Body = z.object({
  name: z.string().trim().min(1).max(200),
  notes: z.string().max(4000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
})

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ folders: await folderTree() })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 8 * 1024)
  if (!body.ok) return body.response
  try {
    const projectId = body.data.project_id?.toLowerCase() ?? null
    if (projectId && !(await getProject(projectId))) return NextResponse.json({ error: 'folder_not_found' }, { status: 404 })
    const list = await createList({ name: body.data.name, notes: body.data.notes ?? null, created_by: auth.via === 'internal' ? 'agent' : 'owner', project_id: projectId })
    return NextResponse.json({ list, href: leadsHref(list.id) }, { status: 201 })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists')
  }
}
