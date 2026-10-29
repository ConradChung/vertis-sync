import { after, NextResponse } from 'next/server'
import { alert, alertLink } from '@/lib/alerts'
import { parseEvent } from '@/lib/slack/payloads'
import { readSlackRequest } from '@/lib/slack/request'

/**
 * Slack Events API (3g). Verified (v0 signature over the raw body, 5-minute
 * window) before anything is parsed; answered at once, the work runs in
 * `after()`.
 *  - url_verification: echo the challenge.
 *  - app_mention: the read-only lead lookup, answered in the thread
 *    (lib/slack/mention.ts).
 *  - app_uninstalled / tokens_revoked: the workspace is marked revoked and
 *    its bindings paused; a reinstall leaves them paused until the owner
 *    re-enables them in Settings → Slack.
 * A Slack retry (X-Slack-Retry-Num) is acknowledged and dropped: the first
 * delivery already did the work, and a mention must not be answered twice.
 */

export const maxDuration = 60

export async function POST(req: Request) {
  const r = await readSlackRequest(req)
  if (!r.ok) return r.response
  const ev = parseEvent(r.raw)
  if (ev?.kind === 'url_verification') return NextResponse.json({ challenge: ev.challenge })
  if (!ev || req.headers.get('x-slack-retry-num')) return NextResponse.json({ ok: true })

  after(async () => {
    try {
      if (ev.kind === 'app_mention') {
        const { answerMention } = await import('@/lib/slack/mention')
        await answerMention(ev)
      } else if (ev.kind === 'revoke') {
        const { revokeInstall } = await import('@/lib/slack/store')
        if (await revokeInstall(ev.team)) {
          const title = `Slack workspace ${ev.team} removed Lume (${ev.reason.replace('_', ' ')})`
          await alert({ source: 'lume.slack', severity: 'warn', title, body: `${title}\nIts channel bindings are paused. A reinstall does not re-enable them; you do, in Settings → Slack.`, link: alertLink('/settings/slack'), owner_only: true })
        }
      }
    } catch (err) {
      console.error('[api/slack/events] handling failed:', err instanceof Error ? err.message : err)
    }
  })
  return NextResponse.json({ ok: true })
}
