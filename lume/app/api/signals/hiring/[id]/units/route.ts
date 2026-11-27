import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { typeHiringUnits } from '@/lib/signals/held'
import { MAX_TYPED_UNITS } from '@/lib/signals/icp'

export const dynamic = 'force-dynamic'

/**
 * POST /api/signals/hiring/:id/units `{ units }`: the owner's unit count for a
 * hiring row that has none, stored with source "owner". Information only: no
 * gate, draft or schedule changes. 404 when the row is gone or already has a
 * count. The owner's own session only.
 */
const Body = z.object({ units: z.number().int().min(1).max(MAX_TYPED_UNITS) }).strict()

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  const body = await parseJsonBody(req, Body, 1024)
  if (!body.ok) return body.response
  try {
    const out = await typeHiringUnits(Number(id), body.data.units)
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: 404 })
    return NextResponse.json(out)
  } catch (err) {
    return dbErrorResponse(err, 'api/signals/hiring/units')
  }
}
