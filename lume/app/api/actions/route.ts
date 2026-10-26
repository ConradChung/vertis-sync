import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { ActionRequestBody, buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * Request a high-risk action (a `pending_actions` row + Telegram prompt).
 * Kinds: `push_to_instantly`, `launch_campaign` (Validate), `assign_leads`,
 * `activate_rule`, `delete_rule` (Rotate), `send_reply`, `pause_campaign`,
 * `resume_campaign`, `create_campaign` (Campaigns) and `decide_gate`.
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

  const body = await parseJsonBody(req, ActionRequestBody, MAX_BODY_BYTES)
  if (!body.ok) return body.response
  const requestedBy = auth.via === 'internal' ? 'agent' : 'user'

  try {
    const built = await buildActionRequest(body.data)
    if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status })
    const action = await createAction(built.kind, built.payload, requestedBy, { ruleId: built.ruleId ?? null })
    return NextResponse.json(
      { ok: true, action: { id: action.id, kind: action.kind, summary: action.payload?.summary ?? built.payload.summary } },
      { status: 201 }
    )
  } catch (err) {
    return actionError(err)
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
