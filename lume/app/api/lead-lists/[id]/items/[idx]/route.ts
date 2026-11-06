import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { getList, updateCell } from '@/lib/leads/lists/store'
import { leadsOnly } from '@/lib/leads/lists/service'

/** `PATCH /api/lead-lists/<id>/items/<idx>` `{ column, value }` — the owner's inline cell edit (session only). */
type Ctx = { params: Promise<{ id: string; idx: string }> }
const Patch = z.object({ column: z.string().min(1).max(200), value: z.string().max(5000) })

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
    const list = await getList(id)
    if (!list) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const refused = leadsOnly(list)
    if (refused) return refused
    const row = await updateCell(id, idx, body.data.column, body.data.value)
    if (!row) return NextResponse.json({ error: 'row_not_found' }, { status: 404 })
    return NextResponse.json({ row })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]/items/[idx]')
  }
}
