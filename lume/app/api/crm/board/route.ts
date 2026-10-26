import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { buildBoard } from '@/lib/crm/board'
import { dbErrorResponse } from '@/lib/http/errors'

/**
 * `GET /api/crm/board?campaign=<instantly id | lume external id | all>` →
 * `CrmBoardResponse`: stages, deals (+ reply snippets), follow-ups due,
 * the rail's reply sparkline, awaiting Won/Lost confirmations, campaigns.
 */
const CAMPAIGN_RE = /^[A-Za-z0-9:_-]{1,200}$/

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const campaign = new URL(req.url).searchParams.get('campaign') ?? 'all'
  if (!CAMPAIGN_RE.test(campaign)) return NextResponse.json({ error: 'invalid_campaign' }, { status: 400 })
  try {
    return NextResponse.json(await buildBoard(campaign))
  } catch (err) {
    return dbErrorResponse(err, 'api/crm/board')
  }
}
