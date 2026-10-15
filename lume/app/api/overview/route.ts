import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getOverview, getScheduledJobs } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import type { OverviewResponse } from '@/lib/db/types'

/**
 * `lume_overview()` merged with `lume_scheduled_jobs()`. Instantly numbers
 * (campaign health, inbox health) are added in Task 8.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const [overview, scheduled_jobs] = await Promise.all([getOverview(), getScheduledJobs()])
    const body: OverviewResponse = { ...overview, scheduled_jobs }
    return NextResponse.json(body)
  } catch (err) {
    return dbErrorResponse(err, 'api/overview')
  }
}
