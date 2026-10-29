import { NextResponse } from 'next/server'
import { dbErrorResponse } from '@/lib/http/errors'
import { listChannels, SlackApiError } from '@/lib/slack/api'
import { slackOwnerGuard } from '@/lib/slack/ownerRoute'
import { getBotToken } from '@/lib/slack/store'

/**
 * GET → `{ channels: [{ id, name, is_private, is_member }] }`: what the bot
 * sees in that workspace (conversations.list; a private channel appears only
 * once @Lume was invited). For the binding picker.
 */
export async function GET(req: Request, ctx: { params: Promise<{ team: string }> }) {
  const denied = await slackOwnerGuard(req)
  if (denied) return denied
  const team = (await ctx.params).team
  if (!/^[TE][A-Z0-9]{2,30}$/.test(team)) return NextResponse.json({ error: 'bad_team' }, { status: 400 })
  let bot
  try {
    bot = await getBotToken(team)
  } catch (err) {
    return dbErrorResponse(err, 'api/slack/channels')
  }
  if (!bot) return NextResponse.json({ error: 'not_installed' }, { status: 404 })
  try {
    return NextResponse.json({ channels: await listChannels(bot.token) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return NextResponse.json({ error: 'slack_error', code: err instanceof SlackApiError ? err.code : 'unknown' }, { status: 502 })
  }
}
