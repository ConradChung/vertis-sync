import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { getReplyDeskConfig, saveReplyDeskSlack } from '@/lib/replydesk/store'
import { listChannels } from '@/lib/slack/api'
import { isSlackConfigured } from '@/lib/slack/config'
import { getBotToken, listInstalls } from '@/lib/slack/store'

export const dynamic = 'force-dynamic'

/** `GET /api/settings/reply-desk` — the SendPilot channel Lume listens to, and the monthly Claude cap. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const cfg = await getReplyDeskConfig()
  return NextResponse.json({ channel_name: cfg.slack.channel_name, channel_id: cfg.slack.channel_id, monthly_cap_usd: cfg.monthly_cap_usd, followup_days: cfg.followup_days })
}

const Body = z.object({ channel_name: z.string().trim().min(1).max(80).regex(/^#?[a-z0-9][a-z0-9._-]*$/) }).strict()

/**
 * `PUT /api/settings/reply-desk` `{ channel_name }` — resolve the channel by
 * name in the Lume workspace and store its id. The bot must already be in
 * the channel (invite it with /invite @Lume). Owner's own session only.
 */
export async function PUT(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_channel_name' }, { status: 400 })
  if (!isSlackConfigured()) return NextResponse.json({ error: 'slack_not_configured' }, { status: 409 })
  const name = parsed.data.channel_name.replace(/^#/, '')
  try {
    const cfg = await getReplyDeskConfig()
    let team = cfg.slack.team_id
    if (!team) {
      const live = (await listInstalls()).filter((i) => !i.revoked_at)
      if (live.length !== 1) return NextResponse.json({ error: live.length ? 'several_slack_installs' : 'no_slack_install' }, { status: 409 })
      team = live[0].team_id
    }
    const bot = await getBotToken(team)
    if (!bot) return NextResponse.json({ error: 'slack_install_missing_or_revoked' }, { status: 409 })
    const ch = (await listChannels(bot.token)).find((c) => c.name === name)
    if (!ch) return NextResponse.json({ error: 'channel_not_found' }, { status: 404 })
    if (!ch.is_member) return NextResponse.json({ error: 'bot_not_in_channel' }, { status: 409 })
    await saveReplyDeskSlack(cfg, { team_id: team, channel_id: ch.id, channel_name: name })
    return NextResponse.json({ channel_name: name, channel_id: ch.id })
  } catch (err) {
    console.error('[api/settings/reply-desk] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
}
