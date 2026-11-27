import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { runTick } from '@/lib/replydesk/engine'
import { liveDeps } from '@/lib/replydesk/live'

/**
 * Reply desk tick: posts due LinkedIn follow-ups and "not now" check-ins as
 * drafts in their Slack thread, weekdays 8 AM to 6 PM Pacific only (anything
 * due outside waits). Authenticated with `X-Lume-Hook-Secret`
 * (= LUME_HOOK_SECRET); pg_cron calls it every 15 minutes
 * (`*_lume_reply_desk.sql`). Drafts only: nothing is ever sent on LinkedIn.
 */
export const maxDuration = 300

export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-Hook-Secret', 'LUME_HOOK_SECRET')
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await runTick(liveDeps()))
  } catch (err) {
    console.error('[api/cron/reply-desk] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'reply_desk_failed' }, { status: 500 })
  }
}
