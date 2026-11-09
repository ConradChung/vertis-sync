import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * POST /api/campaigns/new { name, vertical_id?, template_id | sequences,
 * email_list[], campaign_schedule?, daily_limit, stop_on_reply?, job_id?,
 * list_id?, no_location_sibling? } → 201 { ok, action: { id, kind, summary } }.
 *
 * Files a `new_campaign` pending action (the owner's tap in Lume or Telegram
 * creates the campaign, as a draft). The builder (lib/campaigns/newCampaign.ts)
 * checks the inboxes against Instantly's accounts, the tag and template, and
 * that the name is free. Nothing is created in Instantly here.
 */

const MAX_BODY_BYTES = 256 * 1024

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, z.record(z.string(), z.unknown()), MAX_BODY_BYTES)
  if (!body.ok) return body.response
  try {
    const built = await buildActionRequest({ kind: 'new_campaign', payload: body.data })
    if (!built.ok) {
      return NextResponse.json({ error: built.error, ...(built.problems ? { problems: built.problems } : {}) }, { status: built.status })
    }
    const action = await createAction(built.kind, built.payload, auth.via === 'internal' ? 'agent' : 'user')
    return NextResponse.json(
      { ok: true, action: { id: action.id, kind: action.kind, summary: action.payload?.summary ?? built.payload.summary } },
      { status: 201 }
    )
  } catch (err) {
    if (err instanceof DuplicateActionError) return NextResponse.json({ error: 'duplicate', existing_id: err.existingId || null }, { status: 409 })
    if (err instanceof InvalidActionPayloadError) return NextResponse.json({ error: 'invalid_payload', problems: [err.message] }, { status: 400 })
    return dbErrorResponse(err, 'api/campaigns/new')
  }
}
