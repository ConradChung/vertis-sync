import { NextResponse } from 'next/server'
import { alert, alertLink } from '@/lib/alerts'
import { secretMatches } from '@/lib/auth/secret'
import { cookieFromHeader } from '@/lib/operators/cookie'
import { requestOrigin } from '@/lib/http/origin'
import { oauthAccess } from '@/lib/slack/api'
import { SLACK_STATE_COOKIE as STATE_COOKIE, slackConfig, slackRedirectUri } from '@/lib/slack/config'
import { slackPage } from '@/lib/slack/html'
import { verifyState } from '@/lib/slack/installLink'
import { saveInstall } from '@/lib/slack/store'

/**
 * Slack's OAuth redirect (3g). Public, but the `state` must be the one this
 * browser was given by /api/slack/install (the httpOnly cookie, compared in
 * constant time) and must verify (signed, unexpired). Then the code is
 * exchanged (oauth.v2.access, client secret as HTTP Basic), the bot token is
 * encrypted and stored (lib/slack/crypto.ts), and the owner gets a feed item
 * to bind a channel. Nothing is posted to the workspace until he does. A
 * reinstall (e.g. a revoked client reopening an unexpired link) pauses every
 * existing binding of the workspace; the owner re-enables them in Settings.
 */

function clearState(res: Response): Response {
  const out = new NextResponse(res.body, res)
  out.cookies.set(STATE_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/slack/oauth', maxAge: 0 })
  return out
}

export async function GET(req: Request) {
  if (!slackConfig().configured) return slackPage('Lume for Slack is not set up yet', ['Ask Conrad for a new install link once it is.'], 503)
  const url = new URL(req.url)
  if (url.searchParams.get('error')) return clearState(slackPage('Install cancelled', ['Lume was not added to your Slack. You can close this tab.']))
  const state = url.searchParams.get('state')
  const cookie = cookieFromHeader(req.headers.get('cookie'), STATE_COOKIE)
  const verified = verifyState(state, process.env.LUME_SLACK_TOKEN_KEY!)
  if (!state || !secretMatches(state, cookie) || !verified.ok) {
    return clearState(slackPage('This install could not be verified', ['Start again from the install link Conrad sent you (it must be opened in this browser).'], 400))
  }
  const code = url.searchParams.get('code')
  if (!code || code.length > 500) return clearState(slackPage('This install could not be completed', ['Start again from the install link.'], 400))
  let install
  let saved
  try {
    install = await oauthAccess(code, slackRedirectUri(requestOrigin(req)), process.env.SLACK_CLIENT_ID!.trim(), process.env.SLACK_CLIENT_SECRET!.trim())
    saved = await saveInstall(install)
  } catch (err) {
    console.error('[api/slack/oauth] install failed:', err instanceof Error ? err.message : err)
    return clearState(slackPage('This install could not be completed', ['Slack did not confirm it. Start again from the install link, or ask Conrad.'], 502))
  }
  const name = install.team_name ?? install.team_id
  const title = saved.reinstalled ? `Lume was reinstalled in the Slack workspace ${name}` : `Lume was installed in the Slack workspace ${name}`
  const next = saved.reinstalled
    ? `Its channel bindings were paused${saved.paused ? ` (${saved.paused})` : ''} and stay paused until you re-enable them in Settings → Slack; nothing is posted there until you do.`
    : 'Bind a channel to a vertical in Settings → Slack; nothing is posted there until you do.'
  try {
    await alert({ source: 'lume.slack', severity: 'urgent', title, body: `${title} (${install.team_id}).\n${next}`, link: alertLink('/settings/slack'), owner_only: true })
  } catch (err) {
    console.error('[api/slack/oauth] alert failed:', err instanceof Error ? err.message : err)
  }
  return clearState(
    slackPage(`Lume is installed in ${name}`, ['Invite @Lume to the channel where you want your leads (/invite @Lume), then let Conrad know which channel it is. You can close this tab.'])
  )
}
