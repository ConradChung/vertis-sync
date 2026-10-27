import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { requestOrigin } from '@/lib/http/origin'
import { operatorCookieForbidden, signInUrl } from '@/lib/operators/guard'
import { createOperatorKey, getVertical, listOperators } from '@/lib/operators/store'

/**
 * Grok Bot operator keys.
 *   GET  → `{ operators }` (label, vertical, last_seen, revoked; never a hash).
 *        Owner, operators included (a bot may view).
 *   POST `{ vertical_id, label }` or `{ master: true, label }` → 201
 *        `{ operator, sign_in_url }`. The raw key exists only in this one
 *        response (no-store); only its sha256 is kept. Owner's own session
 *        only: the agent bearer and any `lume_op` cookie get a 403.
 */

const Body = z.union([
  z.object({ vertical_id: z.string().uuid(), label: z.string().trim().min(1).max(80) }).strict(),
  z.object({ master: z.literal(true), label: z.string().trim().min(1).max(80) }).strict(),
])

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ operators: await listOperators({ includeRevoked: true }) })
  } catch (err) {
    return dbErrorResponse(err, 'api/operators')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const bot = operatorCookieForbidden(req)
  if (bot) return bot
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  try {
    let target: Parameters<typeof createOperatorKey>[0]
    if ('master' in body.data) {
      target = { master: true, label: body.data.label }
    } else {
      const v = await getVertical(body.data.vertical_id.toLowerCase())
      if (!v || v.archived_at) return NextResponse.json({ error: 'vertical_not_found' }, { status: 404 })
      target = { verticalId: v.id, label: body.data.label }
    }
    const { operator, rawKey } = await createOperatorKey(target)
    return NextResponse.json(
      { operator, sign_in_url: signInUrl(requestOrigin(req), rawKey) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    return dbErrorResponse(err, 'api/operators')
  }
}
