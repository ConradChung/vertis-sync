import 'server-only'
import { slackApi } from '@/lib/slack/api'
import { getBotToken } from '@/lib/slack/store'
import { getSignalConfig } from '@/lib/signal/store'
import { buildRedditCard } from '@/lib/reddit/card'
import { decideMention, getMention, type RedditMention } from '@/lib/reddit/store'

/**
 * GTM-15: Mark contacted / Skip on a #sales Reddit card, after the
 * interactions route verified Slack's signature. Records the decision only;
 * nothing is sent to anyone. The click must come from the workspace and
 * channel in signal_config.slack and match the row's posted message; the
 * update is conditional on 'posted', so a double click or a teammate just
 * re-renders the card.
 */

export interface RedditActor {
  team: string
  user: string
  channel: string
}

async function render(token: string, row: RedditMention): Promise<void> {
  if (!row.slack_channel_id || !row.slack_ts) return
  const card = buildRedditCard(row)
  await slackApi('chat.update', token, { channel: row.slack_channel_id, ts: row.slack_ts, text: card.text, blocks: card.blocks })
}

export async function redditButton(actor: RedditActor, messageTs: string, mentionId: number, decision: 'contacted' | 'skip'): Promise<'done' | 'already' | 'refused'> {
  const [cfg, row, bot] = await Promise.all([getSignalConfig(), getMention(mentionId), getBotToken(actor.team)])
  if (!bot) return 'refused'
  if (cfg.slack.team_id !== actor.team || cfg.slack.channel_id !== actor.channel) {
    console.warn(`[slack/redditDecide] ${decision} refused for mention ${mentionId}: wrong_channel`)
    return 'refused'
  }
  if (!row || row.slack_team_id !== actor.team || row.slack_channel_id !== actor.channel || row.slack_ts !== messageTs) {
    console.warn(`[slack/redditDecide] ${decision} refused for mention ${mentionId}: stale_card`)
    try {
      await slackApi('chat.postEphemeral', bot.token, { channel: actor.channel, user: actor.user, text: 'This card is out of date; nothing was changed.' })
    } catch (err) {
      console.error('[slack/redditDecide] ephemeral failed:', err instanceof Error ? err.message : err)
    }
    return 'refused'
  }
  const updated = await decideMention(mentionId, decision === 'contacted' ? 'contacted' : 'skipped', actor.user)
  if (!updated) {
    await render(bot.token, (await getMention(mentionId)) ?? row)
    return 'already'
  }
  await render(bot.token, updated)
  return 'done'
}
