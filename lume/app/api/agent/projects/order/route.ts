import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { reorderProjects } from '@/lib/agent/projects'
import { ProjectOrder } from '@/lib/agent/projectModel'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/** PUT `{ ids }` → the sidebar order (ids[0] first). `{ ok, updated }`. */
export async function PUT(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, ProjectOrder, 32 * 1024)
  if (!body.ok) return body.response
  try {
    const updated = await reorderProjects(body.data.ids.map((id) => id.toLowerCase()))
    return NextResponse.json({ ok: true, updated })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects/order')
  }
}
