import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { notConfigured } from '@/lib/http/instantly'
import { INTEREST } from '@/lib/inbox/model'
import { listReplies, type InterestFilter } from '@/lib/inbox/replies'
import { inboxScope } from '@/lib/inbox/scope'
import { inboxFailure, NO_STORE } from '@/lib/inbox/http'

/**
 * GET /api/inbox/replies?campaign_id=&unread=true|false&interest=<name>&limit=1-100&starting_after=
 *
 * Received emails, newest first (Instantly `GET /emails`, `email_type=received`,
 * cached; 20 requests/min, so a 429 says how long to wait). `interest` is an
 * Instantly status name: interested, ooo, not_interested, wrong_person, lost,
 * meeting_booked, … Interested ones are recorded as positive replies (and
 * alerted once). The agent (`list_replies`), the owner and every Grok Bot use
 * this; a vertical bot sees only its vertical's campaigns.
 * Docs: docs/lume/INBOX-MANAGER-API.md.
 */

const interestNames = Object.keys(INTEREST) as [InterestFilter, ...InterestFilter[]]
const Query = z.object({
  campaign_id: z.string().regex(/^[A-Za-z0-9_:-]{1,80}$/).optional(),
  unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  interest: z.enum(interestNames).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  starting_after: z.string().min(1).max(200).optional(),
})

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const params = Object.fromEntries(new URL(req.url).searchParams)
  const q = Query.safeParse(params)
  if (!q.success) return NextResponse.json({ error: 'invalid_query' }, { status: 400 })
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    const scope = await inboxScope(req, auth)
    const out = await listReplies(q.data, scope)
    return NextResponse.json({ configured: true, ...out }, { headers: NO_STORE })
  } catch (err) {
    return inboxFailure(err, 'api/inbox/replies')
  }
}
