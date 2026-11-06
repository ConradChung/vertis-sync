import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { sendLeadListNow } from '@/lib/leads/lists/actions'
import { leadsOnly, withList, type ListCtx } from '@/lib/leads/lists/service'

/**
 * `POST /api/lead-lists/<id>/send` — the Leads page's "Send to validator"
 * (the owner's own click, after a confirm; session only). The list's email
 * rows become a CSV ingest waiting at the usual Approve / Deny gate; Lume
 * never creates the validation job. 422 no_emails, 409 already_sent.
 */
export const maxDuration = 60

export async function POST(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwnerSession(req)
    if (!auth.ok) return auth.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    const refused = leadsOnly(r.list)
    if (refused) return refused
    const out = await sendLeadListNow(r.list.id)
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: 'status' in out ? out.status : 409 })
    return NextResponse.json(out.result, { status: 201 })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]/send')
  }
}
