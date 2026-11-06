import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { getProject } from '@/lib/agent/projects'
import { deleteList, moveList, updateList } from '@/lib/leads/lists/store'
import { leadsHref, leadsOnly, withList, type ListCtx } from '@/lib/leads/lists/service'

/**
 *  GET    → `{ list, href }`.
 *  PATCH  `{ name?, notes?, project_id? }` (owner or the agent: rename, move to a folder or Unfiled with null).
 *  DELETE → the owner's page only (session); the agent files a delete_lead_list approval instead.
 */
const Patch = z
  .object({ name: z.string().trim().min(1).max(200).optional(), notes: z.string().max(4000).nullable().optional(), project_id: z.string().uuid().nullable().optional() })
  .refine((v) => v.name !== undefined || v.notes !== undefined || v.project_id !== undefined, 'nothing to change')

export async function GET(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    return NextResponse.json({ list: r.list, href: leadsHref(r.list.id) })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]')
  }
}

export async function PATCH(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const body = await parseJsonBody(req, Patch, 8 * 1024)
    if (!body.ok) return body.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    let list = r.list
    if (body.data.project_id !== undefined) {
      const pid = body.data.project_id?.toLowerCase() ?? null
      if (pid && !(await getProject(pid))) return NextResponse.json({ error: 'folder_not_found' }, { status: 404 })
      list = (await moveList(list.id, pid)) ?? list
    }
    if (body.data.name !== undefined || body.data.notes !== undefined) list = (await updateList(list.id, { name: body.data.name, notes: body.data.notes })) ?? list
    return NextResponse.json({ list, href: leadsHref(list.id) })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]')
  }
}

export async function DELETE(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwnerSession(req)
    if (!auth.ok) return auth.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    const refused = leadsOnly(r.list)
    if (refused) return refused
    await deleteList(r.list.id)
    return NextResponse.json({ deleted: true })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]')
  }
}
