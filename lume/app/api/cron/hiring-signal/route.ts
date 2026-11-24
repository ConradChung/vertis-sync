import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { parseManualBody } from '@/lib/hiring/config'
import { runHiringTick } from '@/lib/hiring/engine'
import { liveDeps } from '@/lib/hiring/live'

/**
 * GTM-19 Hiring Ops Signal tick. Authenticated with `X-Lume-Hook-Secret`
 * (= LUME_HOOK_SECRET), like the GTM-14 signal routes; called by pg_cron
 * every 30 min once the owner applies the cron migration.
 *
 * No body: a scheduled tick (start due lanes within the caps, read finished
 * runs, process new rows). Manual first run:
 *   `{ "lane": "hiring", "run_cap_usd": 0.5, "max_items": 25, "force": true }`
 * starts one run of that lane now (lane on or off; still within the monthly
 * cap). 200 with a summary; 400 on a malformed override; 500 when a step
 * failed (claims and reservations are released so the next tick retries).
 */
export const maxDuration = 120

export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-Hook-Secret', 'LUME_HOOK_SECRET')
  if (!auth.ok) return auth.response
  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    // No or non-JSON body: a scheduled call.
  }
  const manual = parseManualBody(body)
  if (manual && 'error' in manual) return NextResponse.json({ ok: false, error: manual.error }, { status: 400 })
  try {
    const result = await runHiringTick(new Date(), manual, liveDeps)
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (err) {
    console.error('[api/cron/hiring-signal] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'hiring_signal_failed' }, { status: 500 })
  }
}
