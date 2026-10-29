import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { operatorCookieForbidden } from '@/lib/operators/guard'
import { slackConfig } from '@/lib/slack/config'

/**
 * Settings → Slack's routes: the owner's own browser only (no agent bearer,
 * no Grok Bot `lume_op` cookie), like minting keys or changing a reply mode.
 * `needConfig` also refuses (503, with the missing env names) while the
 * Slack app is not configured.
 */
export async function slackOwnerGuard(req: Request, needConfig = true): Promise<NextResponse | null> {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const bot = operatorCookieForbidden(req)
  if (bot) return bot
  if (needConfig) {
    const cfg = slackConfig()
    if (!cfg.configured) return NextResponse.json({ error: 'slack_not_configured', missing: cfg.missing }, { status: 503 })
  }
  return null
}
