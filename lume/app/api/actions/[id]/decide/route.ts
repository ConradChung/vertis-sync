import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dispatchExecuteNow, executeAction } from '@/lib/actions/execute'
import { claimDecision, getAction, saveAwaitingPayload } from '@/lib/actions/store'
import { editMessage, sendDecisionNote } from '@/lib/adapters/telegram'
import { alert, alertLink, titleFrom } from '@/lib/alerts'
import { hasLiveMaster, routeItemForAction, verticalFor } from '@/lib/operators/route'
import { listOperators, listVerticals } from '@/lib/operators/store'
import { canApproveSend, SELF_APPROVAL_ERROR } from '@/lib/operators/policy'
import { dbErrorResponse } from '@/lib/http/errors'
import { formRedirect, readJsonOrForm } from '@/lib/http/form'
import { uuidParam } from '@/lib/http/json'
import { internalOrigin, requestOrigin } from '@/lib/http/origin'
import { currentOperator } from '@/lib/operators/session'
import { MASTER_ONLY_ERROR } from '@/lib/operators/guard'
import { parseCampaignPayload } from '@/lib/actions/payloads'
import type { Json, PendingActionRow } from '@/lib/db/types'

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
 * safely); it is decided on its /actions page. A vertical Grok Bot may not
 * decide it at all (403 master_only): only the master bot or the owner.
 *
 * Edit (send_reply only, inbox manager 3b): `{ decision: 'approve', body }`
 * (or a `body` form field from /operator) replaces the reply before it is
 * approved. The new payload keeps the first draft as `original_body`, adds
 * `edited_by` (`owner` or `operator:<id>`) and `edited_at`, is re-validated
 * with the send_reply schema (summary rewritten), and is written by the same
 * conditional claim, so it applies only if this decision wins. A body equal
 * to the current one is not an edit. Another kind with a body: 400
 * edit_not_supported; a deny ignores the body.
 *
 * A Grok Bot's Edit is drafting, not approving: the edited payload is saved
 * with `drafted_by_operator` = that bot and the action stays awaiting
 * (200 `{ status: 'awaiting', edited: true }`, form flash edit_saved). By
 * canApproveSend the bot cannot approve it afterwards; the owner, the master
 * bot or another bot of the vertical can. The owner's Edit approves in the
 * same call, as before.
 *
 * Grok Bots, every kind, JSON and form alike:
 *  - a vertical bot may decide only what routes to its own vertical
 *    (`routeItemForAction` → `verticalFor`, as /operator lists it), else 403
 *    campaign_out_of_scope;
 *  - no bot (master included) may APPROVE a send_reply it drafted itself
 *    (lib/operators/policy.ts canApproveSend, owner decision): 403
 *    self_drafted. It may still deny it.
 */

// executeAction may wait on pipeline.decide() (170 s); outlive it.
export const maxDuration = 300

const EDIT_SAVED_MESSAGE = 'Edit saved as your draft; it was not approved or sent and awaits another approver (the owner, the master bot or another bot of the vertical).'

const Body = z.object({ decision: z.enum(['approve', 'reject']), body: z.string().trim().min(1).max(20_000).optional() })

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response

  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })

  const body = await readJsonOrForm(req, Body, 64 * 1024, (f) => ({ decision: f.get('decision'), body: f.get('body') || undefined }))
  if (!body.ok) return body.response
  const approve = body.data.decision === 'approve'
  const form = body.form

  const op = await currentOperator(req)

  const editBody = approve ? (body.data.body ?? null) : null

  // Kinds with their own rules (and an Edit) are checked before any claim.
  let edited: Record<string, Json> | undefined
  if (form || op || editBody !== null) {
    let current: PendingActionRow | null = null
    try {
      current = await getAction(id)
    } catch (err) {
      if (form) return formRedirect(req, form.returnTo, { error: 'db_error' })
      return dbErrorResponse(err, 'api/actions/decide')
    }
    const kind = current?.kind ?? null
    if (editBody !== null) {
      const refuse = (status: number, error: string) =>
        form ? formRedirect(req, form.returnTo, { error }) : NextResponse.json({ error, ...(status === 409 && current ? { status: current.status } : {}) }, { status })
      if (!current) return refuse(404, 'not_found')
      if (current.kind !== 'send_reply') return refuse(400, 'edit_not_supported')
      if (current.status !== 'awaiting') return refuse(409, 'already_handled')
      const p = current.payload ?? {}
      if (editBody !== String(p.body ?? '').trim()) {
        const next = parseCampaignPayload(
          'send_reply',
          {
            ...p,
            body: editBody,
            original_body: typeof p.original_body === 'string' && p.original_body ? p.original_body : p.body,
            edited_by: op ? `operator:${op.id}` : 'owner',
            edited_at: new Date().toISOString(),
          },
          { trustSummary: false }
        )
        if (!next.ok) return refuse(400, 'invalid_body')
        edited = next.payload
      }
    }
    if (kind === 'issue_operator_key') {
      if (op && !op.is_master) {
        if (form) return formRedirect(req, form.returnTo, { error: 'master_only' })
        return NextResponse.json({ error: 'master_only', message: MASTER_ONLY_ERROR }, { status: 403 })
      }
      if (form) return formRedirect(req, form.returnTo, { error: 'key_on_action_page' })
    }
    if (op && current) {
      const deny = (status: number, error: string, message?: string) =>
        form ? formRedirect(req, form.returnTo, { error }) : NextResponse.json({ error, ...(message ? { message } : {}) }, { status })
      if (!op.is_master) {
        let mine = false
        try {
          const [verticals, operators] = await Promise.all([listVerticals(), listOperators({ includeRevoked: false })])
          mine = verticalFor(routeItemForAction(current), verticals, { masterLive: hasLiveMaster(operators) })?.id === op.vertical_id
        } catch (err) {
          if (form) return formRedirect(req, form.returnTo, { error: 'db_error' })
          return dbErrorResponse(err, 'api/actions/decide')
        }
        if (!mine) return deny(403, 'campaign_out_of_scope')
      }
      // A bot's Edit makes the reply its own draft: save it and leave it for another approver.
      if (edited) {
        let saved
        try {
          saved = await saveAwaitingPayload(id, { ...edited, drafted_by_operator: op.id })
        } catch (err) {
          if (form) return formRedirect(req, form.returnTo, { error: 'db_error' })
          return dbErrorResponse(err, 'api/actions/decide')
        }
        if (!saved) return deny(409, 'already_handled')
        if (form) return formRedirect(req, form.returnTo, { ok: 'edit_saved' })
        return NextResponse.json({ ok: true, status: 'awaiting', edited: true, message: EDIT_SAVED_MESSAGE })
      }
      if (approve && !canApproveSend(op, current)) return deny(403, 'self_drafted', SELF_APPROVAL_ERROR)
    }
  }

  let claimed
  try {
    claimed = edited
      ? await claimDecision(id, approve, op ? 'operator' : 'lume', op?.id, edited)
      : await claimDecision(id, approve, op ? 'operator' : 'lume', op?.id)
    if (!claimed) {
      const row = await getAction(id)
      if (form) return formRedirect(req, form.returnTo, { error: row ? 'already_handled' : 'not_found' })
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
  const decidedText = `${verdict} — ${claimed.kind}${edited ? ' (edited)' : ''} (from ${op ? `Grok Bot “${op.label}”` : 'Lume'})`
  const decided = claimed
  const route = routeItemForAction(decided)
  try {
    await alert({
      source: 'lume.actions', severity: 'info', title: titleFrom(decidedText), body: decidedText,
      link: alertLink(`/actions/${id}`), campaign_id: route.campaign_id, scope: route.scope, owner_only: route.owner_only,
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
    if (form) return formRedirect(req, form.returnTo, { ok: 'denied' })
    return NextResponse.json({ ok: true, status: 'rejected' })
  }

  if (form) {
    const dispatched = await dispatchExecuteNow(id, internalOrigin(req))
    if (dispatched === 'dispatched') return formRedirect(req, form.returnTo, { ok: 'approved_running' })
    try {
      const outcome = await executeAction(id)
      // Not claimable here: the dispatched run (or the sweeper) has it. Say where it really stands.
      if (!outcome.ran) {
        if (outcome.status === 'executed') return formRedirect(req, form.returnTo, { ok: 'approved_ran' })
        if (outcome.status === 'failed') return formRedirect(req, form.returnTo, { error: 'approved_failed' })
        if (outcome.status === 'executing') return formRedirect(req, form.returnTo, { ok: 'approved_running' })
        return formRedirect(req, form.returnTo, { error: 'approved_unknown' })
      }
      return outcome.status === 'executed'
        ? formRedirect(req, form.returnTo, { ok: 'approved_ran' })
        : formRedirect(req, form.returnTo, { error: 'approved_failed' })
    } catch {
      return formRedirect(req, form.returnTo, { error: 'approved_retry' })
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
