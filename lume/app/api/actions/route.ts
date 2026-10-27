import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { ActionRequestBody, buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { dbErrorResponse } from '@/lib/http/errors'
import { formAnswer, readJsonOrForm } from '@/lib/http/form'

/**
 * Request a high-risk action (a `pending_actions` row + Telegram prompt).
 * Kinds: `push_to_instantly`, `launch_campaign` (Validate), `assign_leads`,
 * `activate_rule`, `delete_rule` (Rotate), `send_reply`, `pause_campaign`,
 * `resume_campaign`, `create_campaign`, `update_sequence` (Campaigns) and `decide_gate`.
 * Nothing runs here: the row waits for Confirm in Lume or Approve in
 * Telegram, and `lib/actions/execute.ts` runs it after that.
 *
 * The payload is a snapshot of what the owner confirms, built server-side by
 * `buildActionRequest` (lib/actions/build.ts — the same builder the orb
 * agent's high-risk tools use). Unknown keys are dropped and the summary is
 * always server-written. Requests over the internal bearer are recorded as
 * `requested_by: 'agent'`, otherwise `'user'`.
 */

// assign_leads carries up to 500 lead refs; send_reply up to 20k chars.
const MAX_BODY_BYTES = 1024 * 1024

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  // A plain HTML form (/operator) may only file the job kinds: `kind` + `job_id`.
  const body = await readJsonOrForm(req, ActionRequestBody, MAX_BODY_BYTES, (f) => {
    const kind = f.get('kind')
    if (kind !== 'push_to_instantly' && kind !== 'launch_campaign') return {}
    return { kind, payload: { job_id: f.get('job_id') ?? '' } }
  })
  if (!body.ok) return body.response
  const form = body.form
  const answer = async (res: NextResponse) =>
    form ? formAnswer(req, form.returnTo, res, 'filed') : res
  const requestedBy = auth.via === 'internal' ? 'agent' : 'user'

  try {
    const built = await buildActionRequest(body.data)
    if (!built.ok) {
      return answer(NextResponse.json({ error: built.error, ...(built.problems ? { problems: built.problems } : {}) }, { status: built.status }))
    }
    const action = await createAction(built.kind, built.payload, requestedBy, { ruleId: built.ruleId ?? null })
    return answer(
      NextResponse.json(
        { ok: true, action: { id: action.id, kind: action.kind, summary: action.payload?.summary ?? built.payload.summary } },
        { status: 201 }
      )
    )
  } catch (err) {
    return answer(actionError(err))
  }
}

function actionError(err: unknown) {
  if (err instanceof DuplicateActionError) {
    return NextResponse.json({ error: 'duplicate', existing_id: err.existingId || null }, { status: 409 })
  }
  if (err instanceof InvalidActionPayloadError) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }
  return dbErrorResponse(err, 'api/actions')
}
