import { NextResponse } from 'next/server'
import { deleteItem, getItemText } from '@/lib/agent/projects'
import { requireOwner } from '@/lib/auth/guards'
import { readChunk } from '@/lib/agent/projectModel'
import { removeProjectObjects } from '@/lib/agent/projectStorage'
import { badId, notFound } from '@/lib/agent/projectHttp'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'

/**
 * One file or note of one project. The lookup always matches both ids, so a
 * file id from another project is a 404 here (the agent's read_project_file
 * only ever passes its own chat's project).
 *  GET `?offset=` → `{ id, name, kind, readable, truncated, text, offset, next_offset, total_chars }`
 *  DELETE → removes the row and its Storage object.
 */
type Ctx = { params: Promise<{ id: string; fileId: string }> }

async function ids(ctx: Ctx) {
  const p = await ctx.params
  return { id: uuidParam(p.id), fileId: uuidParam(p.fileId) }
}

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const { id, fileId } = await ids(ctx)
  if (!id || !fileId) return badId()
  const offset = Number(new URL(req.url).searchParams.get('offset') ?? 0)
  try {
    const item = await getItemText(id, fileId)
    if (!item) return notFound()
    const chunk = readChunk(item.text_content ?? '', Number.isFinite(offset) ? offset : 0)
    return NextResponse.json({
      id: item.id,
      name: item.name,
      kind: item.kind,
      readable: item.readable,
      truncated: item.truncated ?? false,
      ...chunk,
      ...(item.readable ? {} : { note: 'Stored, but no text could be extracted from this file.' }),
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects/[id]/files/[fileId]')
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const { id, fileId } = await ids(ctx)
  if (!id || !fileId) return badId()
  try {
    const gone = await deleteItem(id, fileId)
    if (!gone) return notFound()
    if (gone.storage_path) await removeProjectObjects([gone.storage_path])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects/[id]/files/[fileId]')
  }
}
