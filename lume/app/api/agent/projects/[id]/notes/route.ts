import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { addNote } from '@/lib/agent/projects'
import { NewNote } from '@/lib/agent/projectModel'
import { badId, projectErrorResponse, projectScope, requireProject } from '@/lib/agent/projectHttp'
import { titleFromPrompt } from '@/lib/agent/history'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * POST `{ content, name? }` → 201 `{ item }`; unnamed notes are named from
 * their first line. 404 when the project is missing (or deleted meanwhile).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, NewNote, 64 * 1024)
  if (!body.ok) return body.response
  try {
    const found = await requireProject(id, await projectScope(req, auth))
    if ('response' in found) return found.response
    const name = body.data.name ?? titleFromPrompt(body.data.content)
    return NextResponse.json({ item: await addNote(id, name, body.data.content) }, { status: 201 })
  } catch (err) {
    return projectErrorResponse(err, 'api/agent/projects/[id]/notes')
  }
}
