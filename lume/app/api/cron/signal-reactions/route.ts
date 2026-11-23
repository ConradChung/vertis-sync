import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { liveDeps, runSignalReactions } from '@/lib/signal/reactions'

/**
 * GTM-14 reactions lane, Monday filing. Authenticated with
 * `X-Lume-Hook-Secret` (= LUME_HOOK_SECRET), like rotation-tick.
 *
 * Due on America/Los_Angeles Monday from 08:00, or with body `{"force":true}`
 * (manual first run: the last 7 days). Files at most one one-tap
 * `influencer_run` card for Frank's unfiled posts (nothing is spent until the
 * owner taps); in dry_run it files nothing and returns the card preview.
 * See lib/signal/reactions.ts.
 */
export const maxDuration = 60

export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-Hook-Secret', 'LUME_HOOK_SECRET')
  if (!auth.ok) return auth.response
  let force = false
  try {
    const body = (await req.json()) as unknown
    force = !!body && typeof body === 'object' && (body as { force?: unknown }).force === true
  } catch {
    // No or non-JSON body: a scheduled call.
  }
  try {
    const result = await runSignalReactions(new Date(), { force }, liveDeps)
    return NextResponse.json(result, { status: result.ok ? 200 : 409 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
