import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { listValidatedJobs } from '@/lib/validate/previewStore'

/**
 * `GET /api/validation-jobs?campaign_id=<instantly id>&unassigned=1` →
 * `{ jobs }`: validated lists picked for / pushed to that Instantly campaign,
 * plus (unassigned=1) lists still waiting for a campaign pick. Read-only;
 * owner or the agent's bearer.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const sp = new URL(req.url).searchParams
  const raw = sp.get('campaign_id')?.trim() || null
  if (raw !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(raw)) return NextResponse.json({ error: 'bad_campaign_id' }, { status: 400 })
  const unassigned = sp.get('unassigned') === '1'
  if (!raw && !unassigned) return NextResponse.json({ jobs: [] })
  try {
    return NextResponse.json({ jobs: await listValidatedJobs({ campaignId: raw, unassigned }) })
  } catch (err) {
    return dbErrorResponse(err, 'api/validation-jobs')
  }
}
