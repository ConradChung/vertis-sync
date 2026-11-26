import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { getScoreboard, setTopObjection } from '@/lib/scoreboard/store'
import { weekOf } from '@/lib/scoreboard/week'

export const dynamic = 'force-dynamic'

/**
 * The weekly scoreboard (owner-zone week, Monday first).
 *  GET → `Scoreboard`: deals that entered Conversation, pilots started,
 *        pilots paid, and the "top objection" line.
 *  PUT → `{ top_objection: string | null }` saves this week's line (the only
 *        thing typed here; the counts come from the CRM).
 */
const Body = z.object({ top_objection: z.string().max(300).nullable() }).strict()

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await getScoreboard(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/scoreboard')
  }
}

export async function PUT(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 4 * 1024)
  if (!body.ok) return body.response
  try {
    const top = await setTopObjection(weekOf().start, body.data.top_objection)
    return NextResponse.json({ ok: true, top_objection: top })
  } catch (err) {
    return dbErrorResponse(err, 'api/scoreboard')
  }
}
