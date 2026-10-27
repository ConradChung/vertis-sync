import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { ALERTS_DEFAULT_LIMIT, listAlerts } from '@/lib/alertsStore'
import { dbErrorResponse } from '@/lib/http/errors'

/**
 * The alert feed (`lume_alerts`), newest first: every notification the
 * pipelines and Lume sent, whatever ALERT_CHANNELS says. `?unacked=1` limits
 * it to unacknowledged rows; `?limit=` (default 50, max 200). Read by the
 * Grok Bot's /operator page.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const params = new URL(req.url).searchParams
  const unackedOnly = params.get('unacked') === '1' || params.get('unacked') === 'true'
  const raw = params.get('limit')
  const limit = raw && /^\d+$/.test(raw) ? Number(raw) : ALERTS_DEFAULT_LIMIT
  try {
    return NextResponse.json({ alerts: await listAlerts({ unackedOnly, limit }) })
  } catch (err) {
    return dbErrorResponse(err, 'api/alerts')
  }
}
