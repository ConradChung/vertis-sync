import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { notConfigured } from '@/lib/http/instantly'
import { getThread } from '@/lib/inbox/replies'
import { inboxScope } from '@/lib/inbox/scope'
import { inboxFailure, NO_STORE } from '@/lib/inbox/http'

/**
 * GET /api/inbox/thread?reply_to_uuid=<email id> | ?thread_id=<id>
 *
 * The whole conversation, oldest → newest, quotes trimmed, plus
 * `latest_inbound` (what a reply answers: its `reply_to_uuid` and our
 * `eaccount`). Cached 30 s; 429 + Retry-After past Instantly's 20/min.
 * Scoped like /api/inbox/replies. Docs: docs/lume/INBOX-MANAGER-API.md.
 */

const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const Query = z
  .object({ reply_to_uuid: Id.optional(), thread_id: Id.optional() })
  .refine((q) => !!q.reply_to_uuid !== !!q.thread_id, 'one of reply_to_uuid or thread_id')

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!q.success) return NextResponse.json({ error: 'invalid_query' }, { status: 400 })
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    const thread = await getThread(q.data, await inboxScope(req, auth))
    return NextResponse.json({ configured: true, thread }, { headers: NO_STORE })
  } catch (err) {
    return inboxFailure(err, 'api/inbox/thread')
  }
}
