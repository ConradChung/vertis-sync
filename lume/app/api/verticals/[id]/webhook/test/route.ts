import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { operatorCookieForbidden } from '@/lib/operators/guard'
import { getVertical } from '@/lib/operators/store'
import { alertLink } from '@/lib/alerts'
import { pushSummary } from '@/lib/webhooks/push'
import { sendPush } from '@/lib/webhooks/deliver'

/**
 * POST /api/verticals/<id>/webhook/test — "Send test": one signed push of
 * type `test`, awaited (5 s timeout, one retry) → `{ ok, status?, error?,
 * attempts }`, or 404 no_webhook. The owner's own session only.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const bot = operatorCookieForbidden(req)
  if (bot) return bot
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  try {
    const v = await getVertical(id)
    if (!v || v.archived_at) return NextResponse.json({ error: 'vertical_not_found' }, { status: 404 })
    const out = await sendPush(id, { type: 'test', vertical: v.name, item_id: 'test', summary: pushSummary('test', {}), link: alertLink('/operator') })
    if ('skipped' in out) return NextResponse.json({ error: 'no_webhook' }, { status: 404 })
    return NextResponse.json(out)
  } catch (err) {
    return dbErrorResponse(err, 'api/verticals/[id]/webhook/test')
  }
}
