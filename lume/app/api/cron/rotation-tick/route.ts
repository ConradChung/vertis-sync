import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { runRotationTick } from '@/lib/rules/tick'

/**
 * Target of pg_cron `lume-rotation-tick` (every 15 min, via
 * `lume_rotation_tick()` → pg_net). Authenticated with `X-Lume-Hook-Secret`
 * (= LUME_HOOK_SECRET, the same secret the gate-opened hook uses).
 *
 * Notify-only: expires stale pending actions, then for each due rule creates
 * at most one `pending_actions(kind='assign_leads')` + Telegram prompt. It
 * never inserts into lead_bank and never calls Instantly itself. Then it
 * sweeps approved actions whose execute was cut (`sweepStuckActions`, the
 * owner already approved them). See lib/rules/tick.ts for the claim order.
 *
 * 200 with per-rule outcomes (a rule that errored is reported, not thrown);
 * 500 only when the rules, expiry or sweep query itself failed.
 */
export const maxDuration = 60

export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-Hook-Secret', 'LUME_HOOK_SECRET')
  if (!auth.ok) return auth.response
  const result = await runRotationTick(new Date())
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}
