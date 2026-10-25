import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { executeAction } from '@/lib/actions/execute'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'

/**
 * Run an approved pending action. Called by telegram-inbox after a Telegram
 * `lume_ok` (header `X-Lume-Secret` = LUME_ACTION_SECRET, body `{}`).
 * Idempotent: the executor's claim (`approved + claimed + executed_at is
 * null`) lets one call run; every other call is a 200 no-op.
 */

export const maxDuration = 300

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireSecret(req, 'x-lume-secret', 'LUME_ACTION_SECRET')
  if (!auth.ok) return auth.response

  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })

  try {
    const outcome = await executeAction(id)
    if (!outcome.ran) {
      if (outcome.reason === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
      return NextResponse.json({ ok: true, noop: true, status: outcome.status })
    }
    return NextResponse.json({ ok: outcome.status === 'executed', status: outcome.status, error: outcome.error })
  } catch (err) {
    return dbErrorResponse(err, 'api/actions/execute')
  }
}
