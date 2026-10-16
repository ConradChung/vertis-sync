import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { decide } from '@/lib/adapters/pipeline'
import { parseCallbackData } from '@/lib/adapters/pipeline.actions'
import { logEvent } from '@/lib/db/service'
import { parseJsonBody } from '@/lib/http/json'
import { decideHttp } from '@/lib/validate/decideResult'

/**
 * Decide a gate exactly as a Telegram tap would: the `callback_data` goes to
 * the telegram-inbox entrypoint (`pipeline.decide()`), which runs the same
 * conditional-PATCH claim and reports `claimed`:
 *   true  → gate closed            → 200
 *   false → gate set unchanged     → 409 already_handled (someone else won)
 *   null  → not observable         → 200 (the handler reports in Telegram)
 * A timeout is "still working": 202, and the screen re-reads the gate.
 *
 * Steps that need a confirmation (`push_go`, `camp_launch`) and the pending
 * action buttons (`lume_ok`/`lume_no`) are refused here: they go through
 * `/api/actions` (a `pending_actions` row) and its decide/execute routes.
 */

// decide() waits up to 170 s for the edge function; outlive it.
export const maxDuration = 300

const Body = z.object({ callback_data: z.string().min(1).max(128) })

const NEEDS_CONFIRMATION: ReadonlySet<string> = new Set(['push_go', 'camp_launch', 'lume_ok', 'lume_no'])

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  const body = await parseJsonBody(req, Body, 1024)
  if (!body.ok) return body.response
  const callbackData = body.data.callback_data

  const parsed = parseCallbackData(callbackData)
  if (!parsed) return NextResponse.json({ error: 'bad_callback_data' }, { status: 400 })
  if (NEEDS_CONFIRMATION.has(parsed.action)) {
    return NextResponse.json({ error: 'needs_confirmation' }, { status: 400 })
  }

  const result = await decide(callbackData)
  const http = decideHttp(result)
  if (!result.ok && http.status !== 202) {
    console.error(`[api/gates/decide] ${parsed.action}: entrypoint ${result.status} ${result.error}`)
  }

  if (result.ok && (http.status === 200 || http.status === 409)) {
    try {
      await logEvent({
        type: 'lume.decision',
        source: 'lume',
        source_id: result.target_id || parsed.targetId,
        title: `${parsed.action} from Lume`,
        payload: { claimed: result.claimed, action: parsed.action },
      })
    } catch (err) {
      // The decision already happened; a missing feed row must not turn it into an error.
      console.error('[api/gates/decide] logEvent failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json(http.body, { status: http.status })
}
