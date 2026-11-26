import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { loadReplies } from '@/lib/replies/store'

export const dynamic = 'force-dynamic'

/**
 * GET → `RepliesPayload`: every awaiting pending action and every unhandled
 * positive reply as one list, longest-waiting first. Read only: approvals are
 * decided through `/api/actions/<id>/decide`, and nothing here sends.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await loadReplies(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/replies')
  }
}
