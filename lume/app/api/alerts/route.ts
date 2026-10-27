import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { ALERTS_DEFAULT_LIMIT, ALERTS_MAX_LIMIT, listAlerts } from '@/lib/alertsStore'
import { uuidParam } from '@/lib/http/json'
import { hasLiveMaster, verticalFor } from '@/lib/operators/route'
import { listOperators, listVerticals } from '@/lib/operators/store'
import { dbErrorResponse } from '@/lib/http/errors'

/**
 * The alert feed (`lume_alerts`), newest first: every notification the
 * pipelines and Lume sent, whatever ALERT_CHANNELS says. `?unacked=1` limits
 * it to unacknowledged rows; `?limit=` (default 50, max 200). Read by the
 * Grok Bot's /operator page.
 *
 * `?vertical=<id>`: only the alerts that route to that vertical
 * (`verticalFor` on the alert's campaign_id / scope; the default vertical
 * takes the rest), read from the newest 200 then cut to `limit`.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const params = new URL(req.url).searchParams
  const unackedOnly = params.get('unacked') === '1' || params.get('unacked') === 'true'
  const raw = params.get('limit')
  const limit = raw && /^\d+$/.test(raw) ? Number(raw) : ALERTS_DEFAULT_LIMIT
  const rawVertical = params.get('vertical')
  const verticalId = rawVertical ? uuidParam(rawVertical) : null
  if (rawVertical && !verticalId) return NextResponse.json({ error: 'bad_vertical' }, { status: 400 })
  try {
    if (!verticalId) return NextResponse.json({ alerts: await listAlerts({ unackedOnly, limit }) })
    const [alerts, verticals, operators] = await Promise.all([
      listAlerts({ unackedOnly, limit: ALERTS_MAX_LIMIT }),
      listVerticals(),
      listOperators(),
    ])
    const n = Math.min(Math.max(Math.floor(limit), 1), ALERTS_MAX_LIMIT)
    const opts = { masterLive: hasLiveMaster(operators) }
    const mine = alerts.filter((a) => verticalFor(a, verticals, opts)?.id === verticalId).slice(0, n)
    return NextResponse.json({ alerts: mine })
  } catch (err) {
    return dbErrorResponse(err, 'api/alerts')
  }
}
