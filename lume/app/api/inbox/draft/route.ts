import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError } from '@/lib/actions/create'
import { getEmail } from '@/lib/adapters/instantlyEmails'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { notConfigured } from '@/lib/http/instantly'
import { replyCardOf } from '@/lib/inbox/model'
import { DraftBody } from '@/lib/inbox/schemas'
import { actorOf, campaignAllowed, inboxScope, InboxError, outOfScope } from '@/lib/inbox/scope'
import { inboxFailure, NO_STORE, readInboxJson } from '@/lib/inbox/http'

/**
 * POST /api/inbox/draft — a Grok Bot (or the owner) files a reply for
 * approval: `{ reply_to_uuid, body, subject?, verdict?, proposed_times?,
 * research_note? }` → a `send_reply` pending action built exactly like the
 * agent's (lib/actions/build.ts: the receiving inbox, the thread, the lead's
 * message, name and company come from Instantly + the CRM). It appears under
 * Needs confirmation on /operator and in Lume; nothing is sent until someone
 * approves (send_reply always asks), unless the campaign is in Auto reply
 * mode and its grant approves it (status 'approved', auto_approved: true). One reply per inbound email: 409
 * `already_drafted_or_replied` with the existing action. 201 `{ action_id,
 * deep_link, summary, reply }`. docs/lume/INBOX-MANAGER-API.md.
 */
export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await readInboxJson(req, DraftBody, 64 * 1024)
  if (!body.ok) return body.response
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    const scope = await inboxScope(req, auth)
    const email = await getEmail(body.data.reply_to_uuid)
    if (!email) throw new InboxError(404, 'email_not_found')
    if (!campaignAllowed(scope, email.campaign_id)) throw outOfScope()

    const { reply_to_uuid, body: text, subject, verdict, proposed_times, research_note } = body.data
    const built = await buildActionRequest({
      kind: 'send_reply',
      payload: {
        reply_to_uuid,
        body: text,
        ...(subject ? { subject } : {}),
        ...(verdict ? { verdict } : {}),
        ...(proposed_times?.length ? { proposed_times } : {}),
        ...(research_note ? { research_note } : {}),
        drafted_by: actorOf(scope, auth.via),
      },
    })
    if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status })
    // The drafting bot may not approve its own reply (lib/operators/policy.ts).
    if (scope.operator) built.payload.drafted_by_operator = scope.operator.id
    try {
      const action = await createAction(built.kind, built.payload, auth.via === 'internal' ? 'agent' : 'user')
      return NextResponse.json(
        {
          ok: true,
          action_id: action.id,
          deep_link: `/actions/${action.id}`,
          summary: built.payload.summary,
          // 'approved' + auto_approved: the campaign is in Auto reply mode and its grant approved it (it sends after the live re-check).
          status: action.status,
          auto_approved: action.decided_via === 'grant',
          reply: replyCardOf(built.payload),
        },
        { status: 201, headers: NO_STORE }
      )
    } catch (err) {
      if (err instanceof DuplicateActionError) {
        return NextResponse.json({ error: 'already_drafted_or_replied', action_id: err.existingId || null }, { status: 409 })
      }
      throw err
    }
  } catch (err) {
    return inboxFailure(err, 'api/inbox/draft')
  }
}
