import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { executeAction } from '@/lib/actions/execute'
import { claimDecision, getAction } from '@/lib/actions/store'
import { editMessage, sendDecisionNote } from '@/lib/adapters/telegram'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * Confirm / Cancel a pending action from Lume. Runs the same claim as
 * telegram-inbox's lume_ok / lume_no (`claim_status=awaiting` → claimed,
 * `status` → approved | rejected, `decided_via='lume'`), so a Lume click and a
 * Telegram tap race for one row and exactly one wins; the loser gets 409
 * already_handled. On approve this request runs the executor itself.
 *
 * Owner session only: the agent's internal bearer is a 403, so a tool call
 * can never approve its own pending action.
 */

// executeAction may wait on pipeline.decide() (170 s); outlive it.
export const maxDuration = 300

const Body = z.object({ decision: z.enum(['approve', 'reject']) })

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response

  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })

  const body = await parseJsonBody(req, Body, 256)
  if (!body.ok) return body.response
  const approve = body.data.decision === 'approve'

  let claimed
  try {
    claimed = await claimDecision(id, approve)
    if (!claimed) {
      const row = await getAction(id)
      if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      return NextResponse.json({ error: 'already_handled', status: row.status }, { status: 409 })
    }
  } catch (err) {
    return dbErrorResponse(err, 'api/actions/decide')
  }

  // Tell the Telegram thread: strip the prompt's buttons, then the usual note.
  const verdict = approve ? '✅ Approved' : '❌ Rejected'
  try {
    if (claimed.telegram_message_id) {
      await editMessage(claimed.telegram_message_id, `${verdict} — ${claimed.kind} (from Lume)`)
    }
    await sendDecisionNote(approve ? 'lume_ok' : 'lume_no', id)
  } catch (err) {
    console.error('[api/actions/decide] telegram note failed:', err instanceof Error ? err.message : err)
  }

  if (!approve) return NextResponse.json({ ok: true, status: 'rejected' })

  try {
    const outcome = await executeAction(id)
    if (!outcome.ran) return NextResponse.json({ ok: true, status: outcome.status ?? 'approved' }, { status: 202 })
    const timedOut = outcome.status === 'executed' && outcome.result.timeout === true
    return NextResponse.json(
      { ok: outcome.status === 'executed', status: outcome.status, result: outcome.result, error: outcome.error },
      { status: timedOut ? 202 : 200 }
    )
  } catch (err) {
    // Approved but the executor could not finish; the sweeper retries rows
    // still `approved`.
    return dbErrorResponse(err, 'api/actions/decide')
  }
}
