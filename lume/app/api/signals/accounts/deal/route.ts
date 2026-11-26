import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { startDeal } from '@/lib/signals/store'

export const dynamic = 'force-dynamic'

/**
 * POST /api/signals/accounts/deal `{ key }` — "Start deal": a CRM deal for
 * the account in the Conversation stage (campaign `signals`), linked from the
 * account. Pressing it again returns the same deal. A row on the owner's own
 * board: nothing is sent and no pipeline or Instantly state changes. The
 * owner's own session only (the agent does not start deals).
 */
const Body = z.object({ key: z.string().regex(/^[dnr]:.{1,200}$/) }).strict()

export async function POST(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 2 * 1024)
  if (!body.ok) return body.response
  try {
    const out = await startDeal(body.data.key)
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: 404 })
    return NextResponse.json(out, { status: out.created ? 201 : 200 })
  } catch (err) {
    return dbErrorResponse(err, 'api/signals/accounts/deal')
  }
}
