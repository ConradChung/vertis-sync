import { NextResponse } from 'next/server'
import { alert, alertLink } from '@/lib/alerts'
import { dbErrorResponse } from '@/lib/http/errors'
import { slackApi } from '@/lib/slack/api'
import { slackOwnerGuard } from '@/lib/slack/ownerRoute'
import { getBotToken, revokeInstall } from '@/lib/slack/store'

/**
 * POST → revoke a workspace: Slack is asked to revoke the bot token
 * (auth.revoke, best effort) and the row is marked revoked, so nothing is
 * posted or decided from there again. Works while the env is incomplete too
 * (a revoke must never be blocked). A reinstall from a new link restores it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ team: string }> }) {
  const denied = await slackOwnerGuard(req, false)
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
