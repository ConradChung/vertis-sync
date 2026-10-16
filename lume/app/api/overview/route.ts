import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { buildOverview } from '@/lib/overview/build'

/**
 * The whole Overview in one response (`OverviewPayload`): `lume_overview()`,
 * scheduled jobs with `next_run`, the reply feed, agent activity, 7-day reply
 * counts, the campaign strip with health, and Instantly totals + accounts
 * when `INSTANTLY_API_KEY` is set (`instantly: { configured: false }` if not).
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await buildOverview(new Date()))
  } catch (err) {
    return dbErrorResponse(err, 'api/overview')
  }
}
