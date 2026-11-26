import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { SIGNAL_STATUSES, TOUCH_CHANNELS } from '@/lib/signals/merge'
import { patchAccount } from '@/lib/signals/store'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/signals/accounts `{ key, status? , touch?: { channel, done } }`
 * A status (new, working, replied, dropped) or a manual touch tick (email,
 * LinkedIn, call) on one account of the Signals inbox. It records what the
 * owner did by hand: nothing is emailed, messaged or called from here, and
 * the signal source tables are not written. 404 when the key is not an
 * account in the inbox.
 */
const Body = z
  .object({
    key: z.string().regex(/^[dnr]:.{1,200}$/),
    status: z.enum(SIGNAL_STATUSES).optional(),
    touch: z.object({ channel: z.enum(TOUCH_CHANNELS), done: z.boolean() }).strict().optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.touch !== undefined)

export async function PATCH(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 4 * 1024)
  if (!body.ok) return body.response
  try {
    const state = await patchAccount(body.data.key, { status: body.data.status, touch: body.data.touch })
    if (!state) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ ok: true, state })
  } catch (err) {
    return dbErrorResponse(err, 'api/signals/accounts')
  }
}
