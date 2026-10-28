import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { addNote, getProject } from '@/lib/agent/projects'
import { NewNote } from '@/lib/agent/projectModel'
import { badId, notFound } from '@/lib/agent/projectHttp'
import { titleFromPrompt } from '@/lib/agent/history'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/** POST `{ content, name? }` → 201 `{ item }`; unnamed notes are named from their first line. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, NewNote, 64 * 1024)
  if (!body.ok) return body.response
  try {
    if (!(await getProject(id))) return notFound()
    const name = body.data.name ?? titleFromPrompt(body.data.content)
    return NextResponse.json({ item: await addNote(id, name, body.data.content) }, { status: 201 })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects/[id]/notes')
  }
}
