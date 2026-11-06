import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { listRecentJobs } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { RECENT_MS } from '@/lib/validate/jobs'

/**
 * GET → `{ jobs }`: validation jobs still pending / processing, plus those
 * updated in the last 24 h (finished ones, with error_message). Read-only;
 * the Validate page's "Running" section polls it (lib/validate/jobs.ts).
 * Per-job progress stays on `/api/jobs/[id]`.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ jobs: await listRecentJobs(new Date(Date.now() - RECENT_MS)) })
  } catch (err) {
    return dbErrorResponse(err, 'api/jobs')
  }
}
