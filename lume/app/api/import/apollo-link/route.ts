import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { parseJsonBody } from '@/lib/http/json'
import { intakeErrorResponse } from '@/lib/import/errors'
import { createApolloOrder } from '@/lib/import/ingest'
import { parseApolloUrl } from '@/lib/import/messages'

/**
 * An Apollo people-search link → `apollo_orders` row `awaiting_count` + the
 * telegram-inbox count prompt. Nothing is spent here: the order is placed
 * only when a count is chosen (Telegram, or the rail's picker sending
 * `lfo_count:<id>:<n>` through `/api/gates/decide`).
 */

const Body = z.object({ url: z.string().max(4096) })

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  const body = await parseJsonBody(req, Body, 8 * 1024)
  if (!body.ok) return body.response
  const url = parseApolloUrl(body.data.url)
  if (!url) return NextResponse.json({ error: 'invalid_apollo_url' }, { status: 400 })

  try {
    const { order, telegram } = await createApolloOrder(url)
    return NextResponse.json({ ok: true, order_id: order.id, status: order.status, telegram, gate: `lfo_count:${order.id}` })
  } catch (err) {
    return intakeErrorResponse(err, 'api/import/apollo-link')
  }
}
