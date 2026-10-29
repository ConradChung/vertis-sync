import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requestOrigin } from '@/lib/http/origin'
import { SLACK_BOT_SCOPES, SLACK_STATE_COOKIE, slackConfig, slackRedirectUri } from '@/lib/slack/config'
import { slackPage } from '@/lib/slack/html'
import { signState, STATE_TTL_MS, verifyInstallLink } from '@/lib/slack/installLink'

/**
 * "Add to Slack" for a client (3g): GET /api/slack/install?t=<install link>.
 * Public (the client has no Lume session), but only with a valid, unexpired
 * install link the owner generated in Settings → Slack. Sets the OAuth state
 * as an httpOnly cookie (10 minutes, scoped to the callback path) and
 * redirects to Slack's consent screen with the minimal bot scopes.
 */

export async function GET(req: Request) {
  const cfg = slackConfig()
  if (!cfg.configured) return slackPage('Lume for Slack is not set up yet', ['Ask Conrad for a new install link once it is.'], 503)
  const key = process.env.LUME_SLACK_TOKEN_KEY!
  const link = verifyInstallLink(new URL(req.url).searchParams.get('t'), key)
  if (!link.ok) {
    return slackPage(link.reason === 'expired' ? 'This install link has expired' : 'This install link is not valid', ['Ask Conrad for a new install link.'], 403)
  }
  const state = signState(key, { nonce: randomBytes(16).toString('base64url'), link: link.nonce, expiresAt: Date.now() + STATE_TTL_MS })
  const authorize = new URL('https://slack.com/oauth/v2/authorize')
  authorize.searchParams.set('client_id', process.env.SLACK_CLIENT_ID!.trim())
  authorize.searchParams.set('scope', SLACK_BOT_SCOPES.join(','))
  authorize.searchParams.set('redirect_uri', slackRedirectUri(requestOrigin(req)))
  authorize.searchParams.set('state', state)
  const res = NextResponse.redirect(authorize.toString(), 302)
  res.cookies.set(SLACK_STATE_COOKIE, state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/slack/oauth', maxAge: Math.floor(STATE_TTL_MS / 1000) })
  res.headers.set('Cache-Control', 'no-store')
  res.headers.set('Referrer-Policy', 'no-referrer')
  return res
}
