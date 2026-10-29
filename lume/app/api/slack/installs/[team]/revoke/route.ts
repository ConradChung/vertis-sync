import { NextResponse } from 'next/server'
import { alert, alertLink } from '@/lib/alerts'
import { dbErrorResponse } from '@/lib/http/errors'
import { slackApi } from '@/lib/slack/api'
import { requireOwnerSession } from '@/lib/auth/guards'
import { slackOwnerChecks } from '@/lib/slack/ownerRoute'
import { getBotToken, revokeInstall } from '@/lib/slack/store'

/**
 * POST → revoke a workspace: Slack is asked to revoke the bot token
 * (auth.revoke, best effort), the row is marked revoked and every binding of
 * the workspace is paused, so nothing is posted or decided from there again.
 * Works while the env is incomplete too (a revoke must never be blocked). A
 * reinstall (from any unexpired link) does NOT restore it: the bindings stay
 * paused until the owner re-enables them in Settings → Slack.
 */
export async function POST(req: Request, ctx: { params: Promise<{ team: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const denied = slackOwnerChecks(req, false)
  if (denied) return denied
  const team = (await ctx.params).team
  if (!/^[TE][A-Z0-9]{2,30}$/.test(team)) return NextResponse.json({ error: 'bad_team' }, { status: 400 })
  try {
    const bot = await getBotToken(team).catch(() => null)
    if (bot) await slackApi('auth.revoke', bot.token, {}).catch((err) => console.error('[api/slack/revoke] auth.revoke failed:', err instanceof Error ? err.message : err))
    const revoked = await revokeInstall(team)
    if (revoked) {
      const title = `Slack workspace ${team} revoked by you`
      await alert({ source: 'lume.slack', severity: 'info', title, body: title, link: alertLink('/settings/slack'), owner_only: true })
    }
    return NextResponse.json({ ok: true, revoked })
  } catch (err) {
    return dbErrorResponse(err, 'api/slack/revoke')
  }
}
