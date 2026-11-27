import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { runContentTick } from '@/lib/content/engine'
import { liveDeps } from '@/lib/content/live'
import { parseManualBody } from '@/lib/content/slots'

/**
 * LinkedIn draft generator tick. Authenticated with `X-Lume-Hook-Secret`
 * (= LUME_HOOK_SECRET), like the other cron routes; pg_cron calls it at
 * 13:30 and 14:30 UTC Tue-Thu and only the call that lands in the 6 AM PT
 * hour writes a draft (Tue Proof, Wed Owner view, Thu Hand-raiser).
 *
 * Manual run: `{ "force": true, "slot": "proof" }` (slot optional on a
 * draft day; Hand-raiser may pass "variant"). Still within the monthly cap,
 * still dry-run unless content_config.dry_run is exactly false. Nothing is
 * ever posted to LinkedIn.
 */
export const maxDuration = 300

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
    const result = await runContentTick(new Date(), manual, liveDeps())
    return NextResponse.json(result, { status: result.ok ? 200 : 400 })
  } catch (err) {
    console.error('[api/cron/content-gen] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'content_gen_failed' }, { status: 500 })
  }
}
