import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { runSignalAlerts } from '@/lib/signal/alerts'

/**
 * GTM-14: post ready signal cards (PM commenters on Frank's posts, weekly
 * reactor digests, lane notices) to #sales. Called by pg_cron with
 * `X-Lume-Hook-Secret` (= LUME_HOOK_SECRET), like rotation-tick. While
 * `signal_config.dry_run` is on (the default) it only saves the cards.
 * Posting hands over drafts to copy by hand; nothing is sent to a lead.
 *
 * 200 with a summary; 500 when a read failed or a send failed (claims are
 * released so the next tick retries).
 */
export const maxDuration = 60

export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-Hook-Secret', 'LUME_HOOK_SECRET')
  if (!auth.ok) return auth.response
  try {
    const result = await runSignalAlerts(new Date())
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (err) {
    console.error('[api/cron/signal-alerts] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'signal_alerts_failed' }, { status: 500 })
  }
}
