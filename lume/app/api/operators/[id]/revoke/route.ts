import { NextResponse } from 'next/server'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { requireOwnerSession } from '@/lib/auth/guards'
import { operatorCookieForbidden } from '@/lib/operators/guard'
import { revokeOperator } from '@/lib/operators/store'

/**
 * Revoke one operator key and sign its bot out (`revokeOperator`). Owner's own
 * session only (no agent bearer, no `lume_op` cookie). `{ revoked: false }`
 * when it was already revoked (the session purge still re-runs).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const bot = operatorCookieForbidden(req)
  if (bot) return bot
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, revoked: await revokeOperator(id) })
  } catch (err) {
    return dbErrorResponse(err, 'api/operators/revoke')
  }
}
