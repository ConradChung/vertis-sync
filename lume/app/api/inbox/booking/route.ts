import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { notConfigured } from '@/lib/http/instantly'
import { logBooking } from '@/lib/inbox/label'
import { BookingBody } from '@/lib/inbox/schemas'
import { actorOf, inboxScope } from '@/lib/inbox/scope'
import { inboxFailure, NO_STORE, readInboxJson } from '@/lib/inbox/http'

/**
 * POST /api/inbox/booking — log a booked call (the Grok Bot booked it in
 * the calendar). `{ reply_to_uuid | lead_email + campaign_id, time, event_id?,
 * event_link?, notes? }` → Instantly "meeting booked", CRM stage Meeting
 * booked + a meeting activity (deduped on event_id), reply handled.
 * lib/inbox/label.ts; docs/lume/INBOX-MANAGER-API.md.
 */
export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await readInboxJson(req, BookingBody)
  if (!body.ok) return body.response
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    const scope = await inboxScope(req, auth)
    const out = await logBooking(body.data, scope, actorOf(scope, auth.via))
    return NextResponse.json({ ok: true, ...out }, { headers: NO_STORE })
  } catch (err) {
    return inboxFailure(err, 'api/inbox/booking')
  }
}
