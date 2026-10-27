import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwnerSession } from '@/lib/auth/guards'
import { decide } from '@/lib/adapters/pipeline'
import { parseCallbackData } from '@/lib/adapters/pipeline.actions'
import { logEvent } from '@/lib/db/service'
import { formAnswer, readJsonOrForm } from '@/lib/http/form'
import { currentOperator } from '@/lib/operators/session'
import { decideHttp } from '@/lib/validate/decideResult'

/**
 * Decide a gate exactly as a Telegram tap would: the `callback_data` goes to
 * the telegram-inbox entrypoint (`pipeline.decide()`), which runs the same
 * conditional-PATCH claim and reports `claimed`:
 *   true  → gate closed            → 200
 *   false → gate set unchanged     → 409 already_handled (someone else won)
 *   null  → not observable         → 200 (the handler reports in Telegram)
 * A timeout is "still working": 202, and the screen re-reads the gate.
 *
 * Steps that need a confirmation (`push_go`, `camp_launch`) and the pending
 * action buttons (`lume_ok`/`lume_no`) are refused here: they go through
 * `/api/actions` (a `pending_actions` row) and its decide/execute routes.
 *
 * Owner session only: the agent's internal bearer is a 403 (the agent files a
 * `decide_gate` pending action instead of deciding a gate itself).
 *
 * Also a plain HTML form (the /operator check-in page): `callback_data`, an
 * optional `count` appended as `:<count>` (the Leadsfriday count input), and
 * `return_to`; answered with a 303 back and a flash. A Grok Bot (valid
 * `lume_op` cookie) is named in the `lume.decision` event (`operator_id`);
 * the pipeline row itself records the decision as the entrypoint always has.
 */

// decide() waits up to 170 s for the edge function; outlive it.
export const maxDuration = 300

const Body = z.object({ callback_data: z.string().min(1).max(128) })

const NEEDS_CONFIRMATION: ReadonlySet<string> = new Set(['push_go', 'camp_launch', 'lume_ok', 'lume_no'])

export async function POST(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response

  const body = await readJsonOrForm(req, Body, 1024, (f) => {
    const cb = f.get('callback_data') ?? ''
    const count = (f.get('count') ?? '').trim()
    if (!count) return { callback_data: cb }
    return /^\d{1,6}$/.test(count) ? { callback_data: `${cb}:${count}` } : {}
  })
  if (!body.ok) return body.response
  const callbackData = body.data.callback_data
  const answer = (res: NextResponse, okText?: string) => (body.form ? formAnswer(req, body.form.returnTo, res, okText) : res)

  const parsed = parseCallbackData(callbackData)
  if (!parsed) return answer(NextResponse.json({ error: 'bad_callback_data' }, { status: 400 }))
  if (NEEDS_CONFIRMATION.has(parsed.action)) {
    return answer(NextResponse.json({ error: 'needs_confirmation' }, { status: 400 }))
  }
  const op = await currentOperator(req)

  const result = await decide(callbackData)
  const http = decideHttp(result)
  if (!result.ok && http.status !== 202) {
    console.error(`[api/gates/decide] ${parsed.action}: entrypoint ${result.status} ${result.error}`)
  }

  if (result.ok && (http.status === 200 || http.status === 409)) {
    try {
      await logEvent({
        type: 'lume.decision',
        source: 'lume',
        source_id: result.target_id || parsed.targetId,
        title: op ? `${parsed.action} from Grok Bot “${op.label}”` : `${parsed.action} from Lume`,
        payload: { claimed: result.claimed, action: parsed.action, ...(op ? { decided_via: 'operator', operator_id: op.id } : {}) },
      })
    } catch (err) {
      // The decision already happened; a missing feed row must not turn it into an error.
      console.error('[api/gates/decide] logEvent failed:', err instanceof Error ? err.message : err)
    }
  }

  const res = NextResponse.json(http.body, { status: http.status })
  if (body.form && http.status === 202) return formAnswer(req, body.form.returnTo, res, `Sent ${parsed.action}; still working, re-check shortly`)
  return answer(res, `Decided: ${parsed.action}`)
}
