import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { listAwaitingActions } from '@/lib/approvals/store'
import { toApprovalItem } from '@/lib/approvals/view'
import { dbErrorResponse } from '@/lib/http/errors'

export const dynamic = 'force-dynamic'

/**
 * GET → `{ count, items }`: every awaiting pending action (all kinds, newest
 * first) as Approvals list rows, for `/actions` and the nav badge. Read only;
 * decisions go through `/api/actions/<id>/decide`.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const { rows, count } = await listAwaitingActions()
    return NextResponse.json({ count, items: rows.map(toApprovalItem) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/actions/pending')
  }
}
