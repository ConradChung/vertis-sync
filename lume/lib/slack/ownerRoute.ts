import { NextResponse } from 'next/server'
import { operatorCookieForbidden } from '@/lib/operators/guard'
import { slackConfig } from '@/lib/slack/config'

/**
 * Settings → Slack's routes, after the route's own `requireOwnerSession`:
 * no Grok Bot `lume_op` cookie (like minting keys or changing a reply mode),
 * and with `needConfig`, a 503 (with the missing env names) while the Slack
 * app is not configured.
 */
export function slackOwnerChecks(req: Request, needConfig = true): NextResponse | null {
  const bot = operatorCookieForbidden(req)
  if (bot) return bot
  if (needConfig) {
    const cfg = slackConfig()
    if (!cfg.configured) return NextResponse.json({ error: 'slack_not_configured', missing: cfg.missing }, { status: 503 })
  }
  return null
}
