import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { releaseHeld } from '@/lib/signals/held'
import { MAX_TYPED_UNITS } from '@/lib/signals/icp'

export const dynamic = 'force-dynamic'

/**
 * POST /api/signals/people/:id/units `{ units }` — the owner's unit count for
 * a LinkedIn person the ICP gate held ("Units unknown"). At or above the
 * minimum the person goes back on the filter (contacts → card); below it
 * they are skipped. Only a row still held changes (409 otherwise). The
 * owner's own session only.
 */
const Body = z.object({ units: z.number().int().min(0).max(MAX_TYPED_UNITS) }).strict()

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  const body = await parseJsonBody(req, Body, 1024)
  if (!body.ok) return body.response
  try {
    const out = await releaseHeld(Number(id), body.data.units)
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: 409 })
    return NextResponse.json(out)
  } catch (err) {
    return dbErrorResponse(err, 'api/signals/people/units')
  }
}
