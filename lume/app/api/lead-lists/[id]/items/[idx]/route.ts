import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { EDITABLE_FIELDS } from '@/lib/leads/lists/model'
import { getList, updateItem } from '@/lib/leads/lists/store'

/** `PATCH /api/lead-lists/<id>/items/<idx>` `{ field: value }` — the owner's inline cell edit (session only). */
type Ctx = { params: Promise<{ id: string; idx: string }> }
const Patch = z.partialRecord(z.enum(EDITABLE_FIELDS), z.string().max(500).nullable()).refine((v) => Object.keys(v).length > 0, 'nothing to change')

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireOwnerSession(req)
    if (!auth.ok) return auth.response
    const p = await ctx.params
    const id = uuidParam(p.id)
    const idx = /^\d{1,6}$/.test(p.idx) ? Number(p.idx) : NaN
    if (!id || !Number.isInteger(idx)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
    const body = await parseJsonBody(req, Patch, 8 * 1024)
    if (!body.ok) return body.response
    if (!(await getList(id))) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const row = await updateItem(id, idx, body.data)
    if (!row) return NextResponse.json({ error: 'row_not_found' }, { status: 404 })
    return NextResponse.json({ row })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]/items/[idx]')
  }
}
