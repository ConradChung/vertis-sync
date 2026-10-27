import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { listDecidedSince } from '@/lib/actions/store'
import { ALERTS_MAX_LIMIT, listAlerts } from '@/lib/alertsStore'
import { getGates } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { verticalCards } from '@/lib/operators/strip'
import { listOperators, listVerticals } from '@/lib/operators/store'

/**
 * The Overview "Verticals" strip: one card per live vertical (last bot
 * check-in, needs-confirmation count, unacked alerts, last action its bot
 * decided). Five cheap reads in parallel; routing in `verticalCards`.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const now = new Date()
  try {
    const [verticals, operators, gates, alerts, decided] = await Promise.all([
      listVerticals(),
      listOperators(),
      getGates(),
      listAlerts({ unackedOnly: true, limit: ALERTS_MAX_LIMIT }),
      listDecidedSince(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), 200),
    ])
    return NextResponse.json({ cards: verticalCards({ verticals, operators, gates, alerts, decided, now }), generated_at: now.toISOString() })
  } catch (err) {
    return dbErrorResponse(err, 'api/overview/verticals')
  }
}
