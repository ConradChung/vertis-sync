import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getScheduledJobs } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { withNextRun } from '@/lib/schedule/nextRun'
import type { ScheduledJobWithNext } from '@/lib/overview/types'

/** `lume_scheduled_jobs()` with `next_run` (UTC, from cron-parser; null for an invalid cron). */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const jobs: ScheduledJobWithNext[] = withNextRun(await getScheduledJobs(), new Date())
    return NextResponse.json(jobs)
  } catch (err) {
    return dbErrorResponse(err, 'api/scheduled-jobs')
  }
}
