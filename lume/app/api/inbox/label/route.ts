import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { notConfigured } from '@/lib/http/instantly'
import { applyLabel } from '@/lib/inbox/label'
import { labelPlan } from '@/lib/inbox/model'
import { LabelBody } from '@/lib/inbox/schemas'
import { actorOf, inboxScope } from '@/lib/inbox/scope'
import { inboxFailure, NO_STORE, readInboxJson } from '@/lib/inbox/http'

/**
 * POST /api/inbox/label — label_reply (low tier; sends nothing).
 * `{ reply_to_uuid | lead_email + campaign_id, category?, verdict?, block?, note? }`:
 * Instantly interest status, blocklist (unsubscribe / hostile / BAD + block),
 * CRM stage (a Lost close is filed for approval), and the reply leaves New
 * replies when no answer is owed. lib/inbox/label.ts; docs/lume/INBOX-MANAGER-API.md.
 */
export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await readInboxJson(req, LabelBody)
  if (!body.ok) return body.response
  // The agent never blocklists directly: its label_reply tool files an approval (kind label_reply).
  if (auth.via === 'internal' && labelPlan(body.data).block) return NextResponse.json({ error: 'approval_required' }, { status: 403 })
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    const scope = await inboxScope(req, auth)
    const out = await applyLabel(body.data, scope, actorOf(scope, auth.via))
    return NextResponse.json({ ok: true, ...out }, { headers: NO_STORE })
  } catch (err) {
    return inboxFailure(err, 'api/inbox/label')
  }
}
