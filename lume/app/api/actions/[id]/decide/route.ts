import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dispatchExecuteNow, executeAction } from '@/lib/actions/execute'
import { claimDecision, getAction } from '@/lib/actions/store'
import { editMessage, sendDecisionNote } from '@/lib/adapters/telegram'
import { alert, alertLink, titleFrom } from '@/lib/alerts'
import { routeItemForAction } from '@/lib/operators/route'
import { dbErrorResponse } from '@/lib/http/errors'
import { formRedirect, readJsonOrForm } from '@/lib/http/form'
import { uuidParam } from '@/lib/http/json'
import { internalOrigin, requestOrigin } from '@/lib/http/origin'
import { currentOperator } from '@/lib/operators/session'

/**
 * Confirm / Cancel a pending action from Lume. Runs the same claim as
 * telegram-inbox's lume_ok / lume_no (`claim_status=awaiting` → claimed,
 * `status` → approved | rejected, `decided_via='lume'`), so a Lume click and a
 * Telegram tap race for one row and exactly one wins; the loser gets 409
 * already_handled. On approve this request runs the executor itself.
 *
 * Owner session only: the agent's internal bearer is a 403, so a tool call
 * can never approve its own pending action. A Grok Bot signed in with its
 * operator key (valid `lume_op` cookie) is recorded as `decided_via='operator'`
 * + `decided_by_operator`.
 *
 * Also a plain HTML form (`decision=approve|reject&return_to=/operator…`,
 * the /operator check-in page): same claim, then a 303 back with a flash. An
 * approved form decision is dispatched to `/api/actions/<id>/execute` (its own
 * function, like the sweeper) instead of being awaited here, so the page comes
 * back at once; without LUME_ACTION_SECRET it runs inline.
 *
 * `issue_operator_key`: the executor runs here with `revealOnce`, and the raw
 * sign-in link comes back in this one JSON response (`sign_in_url`, no-store)
 * and nowhere else. A form post for it is refused (a redirect cannot carry it
 * safely); it is decided on its /actions page.
 */

// executeAction may wait on pipeline.decide() (170 s); outlive it.
export const maxDuration = 300

const Body = z.object({ decision: z.enum(['approve', 'reject']) })

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response

  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })

  const body = await readJsonOrForm(req, Body, 1024, (f) => ({ decision: f.get('decision') }))
  if (!body.ok) return body.response
  const approve = body.data.decision === 'approve'
  const form = body.form

  const op = await currentOperator(req)

  if (form) {
    try {
      const row = await getAction(id)
      if (row?.kind === 'issue_operator_key') {
        return formRedirect(req, form.returnTo, { error: `Decide this on /actions/${id}: its sign-in link is shown once there` })
      }
    } catch {
      return formRedirect(req, form.returnTo, { error: 'db_error' })
    }
  }

  let claimed
  try {
    claimed = await claimDecision(id, approve, op ? 'operator' : 'lume', op?.id)
    if (!claimed) {
      const row = await getAction(id)
      if (form) return formRedirect(req, form.returnTo, { error: row ? `already_handled (${row.status})` : 'not_found' })
      if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      return NextResponse.json({ error: 'already_handled', status: row.status }, { status: 409 })
    }
  } catch (err) {
    if (form) return formRedirect(req, form.returnTo, { error: 'db_error' })
    return dbErrorResponse(err, 'api/actions/decide')
  }

  // Tell the Telegram thread: strip the prompt's buttons, then the usual note.
  const verdict = approve ? '✅ Approved' : '❌ Rejected'
  // The feed gets one row for the decision; Telegram gets exactly the edit and
  // note as before while ALERT_CHANNELS includes telegram.
  const decidedText = `${verdict} — ${claimed.kind} (from ${op ? `Grok Bot “${op.label}”` : 'Lume'})`
  const decided = claimed
  const route = routeItemForAction(decided)
  try {
    await alert({
      source: 'lume.actions', severity: 'info', title: titleFrom(decidedText), body: decidedText,
      link: alertLink(`/actions/${id}`), campaign_id: route.campaign_id, scope: route.scope,
      telegram: async () => {
        if (decided.telegram_message_id) {
          await editMessage(decided.telegram_message_id, decidedText)
        }
        await sendDecisionNote(approve ? 'lume_ok' : 'lume_no', id)
      },
    })
  } catch (err) {
    console.error('[api/actions/decide] telegram note failed:', err instanceof Error ? err.message : err)
  }

  if (!approve) {
    if (form) return formRedirect(req, form.returnTo, { ok: `Denied: ${claimed.kind}` })
    return NextResponse.json({ ok: true, status: 'rejected' })
  }

  if (form) {
    const dispatched = await dispatchExecuteNow(id, internalOrigin(req))
    if (dispatched === 'dispatched') return formRedirect(req, form.returnTo, { ok: `Approved: ${claimed.kind} (running)` })
    try {
      const outcome = await executeAction(id)
      if (!outcome.ran) return formRedirect(req, form.returnTo, { ok: `Approved: ${claimed.kind}` })
      return outcome.status === 'executed'
        ? formRedirect(req, form.returnTo, { ok: `Approved and ran: ${claimed.kind}` })
        : formRedirect(req, form.returnTo, { error: `Approved, but it failed: ${outcome.error ?? 'error'}` })
    } catch {
      return formRedirect(req, form.returnTo, { error: 'Approved, but the executor could not finish; it will be retried' })
    }
  }

  try {
    const outcome = await executeAction(id, { revealOnce: true, origin: requestOrigin(req) })
    if (!outcome.ran) return NextResponse.json({ ok: true, status: outcome.status ?? 'approved' }, { status: 202 })
    const timedOut = outcome.status === 'executed' && outcome.result.timeout === true
    return NextResponse.json(
      {
        ok: outcome.status === 'executed',
        status: outcome.status,
        result: outcome.result,
        error: outcome.error,
        ...(outcome.reveal ? { sign_in_url: outcome.reveal.sign_in_url } : {}),
      },
      { status: timedOut ? 202 : 200, headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    // Approved but the executor could not finish; the sweeper retries rows
    // still `approved`.
    return dbErrorResponse(err, 'api/actions/decide')
  }
}
