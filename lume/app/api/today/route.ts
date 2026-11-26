import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { loadToday } from '@/lib/today/store'

export const dynamic = 'force-dynamic'

/**
 * GET → `TodayPayload`: this week's scoreboard and the queue of what needs
 * doing now (untouched signal accounts, positive replies waiting over an
 * hour, pilot check-ins due, calendar tasks due). Read only.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await loadToday(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/today')
  }
}
