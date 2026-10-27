import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { ackAlerts } from '@/lib/alertsStore'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, UUID_RE } from '@/lib/http/json'
import { currentOperator } from '@/lib/operators/session'

/**
 * Acknowledge alerts: `{ ids: [...] }` or `{ all: true }` (every unacked
 * row). Owner session only, like deciding an action: the agent's internal
 * bearer is a 403. A Grok Bot signed in with its operator key (valid `lume_op`
 * cookie) is recorded in `acked_by_operator`; the owner leaves it null.
 * Already-acked rows are untouched; the response lists the ids this call acked.
 */

const Body = z.union([
  z.object({ ids: z.array(z.string().regex(UUID_RE)).min(1).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
])

export async function POST(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response

  const body = await parseJsonBody(req, Body, 32 * 1024)
  if (!body.ok) return body.response

  const op = await currentOperator(req)
  const target = 'all' in body.data ? { all: true as const } : { ids: body.data.ids.map((id) => id.toLowerCase()) }
  try {
    const acked = await ackAlerts(target, op?.id ?? null)
    return NextResponse.json({ ok: true, acked })
  } catch (err) {
    return dbErrorResponse(err, 'api/alerts/ack')
  }
}
