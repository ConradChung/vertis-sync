import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { buildOverview } from '@/lib/overview/build'

/**
 * Database half of the Overview (`OverviewPayload`): `lume_overview()`,
 * scheduled jobs with `next_run`, the reply feed, agent activity and the
 * owner-zone 7-day series. No Instantly calls: those live in
 * `/api/overview/instantly` so a burst of Realtime refetches stays in the DB.
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
