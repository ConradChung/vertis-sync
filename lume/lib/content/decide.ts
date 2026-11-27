import 'server-only'
import { buildContentMessage } from '@/lib/content/message'
import { generateDraft } from '@/lib/content/engine'
import { getContentConfig, liveDeps } from '@/lib/content/live'
import { decideDraft, getDraft, type ContentDraft } from '@/lib/content/store'
import { slackApi } from '@/lib/slack/api'
import { getBotToken } from '@/lib/slack/store'

/**
 * Redo / Skip on a #content-gen draft, after the interactions route verified
 * Slack's signature. The click must come from the workspace and channel in
 * content_config.slack and match the draft's posted message; the status
 * change is conditional on 'accepted', so a double click decides once.
 * Skip only records the decision. Redo marks the draft superseded and writes
 * a new draft for the same slot (same cap, same rules, same dry_run).
 */

export interface ContentActor {
  team: string
  user: string
  channel: string
}

async function render(token: string, d: ContentDraft): Promise<void> {
  if (!d.slack_channel_id || !d.slack_ts || !d.body || !d.formula) return
  const msg = buildContentMessage({
    id: d.id,
    slot: d.slot,
    variant: d.variant,
    formula: d.formula,
    body: d.body,
    first_comment: d.first_comment ?? '',
    char_count: d.char_count ?? d.body.length,
    fact_ids: d.fact_ids ?? [],
    status: d.status,
    decided_by: d.decided_by,
  })
  await slackApi('chat.update', token, { channel: d.slack_channel_id, ts: d.slack_ts, text: msg.text, blocks: msg.blocks })
}

async function ephemeral(token: string, actor: ContentActor, text: string): Promise<void> {
  try {
    await slackApi('chat.postEphemeral', token, { channel: actor.channel, user: actor.user, text })
  } catch (err) {
    console.error('[content/decide] ephemeral failed:', err instanceof Error ? err.message : err)
  }
}

export async function contentButton(actor: ContentActor, messageTs: string, draftId: number, decision: 'redo' | 'skip'): Promise<'done' | 'already' | 'refused'> {
  const [cfg, row, bot] = await Promise.all([getContentConfig(), getDraft(draftId), getBotToken(actor.team)])
  if (!bot) return 'refused'
  if (cfg.slack.team_id !== actor.team || cfg.slack.channel_id !== actor.channel) {
    console.warn(`[content/decide] ${decision} refused for draft ${draftId}: wrong_channel`)
    return 'refused'
  }
  if (!row || row.slack_team_id !== actor.team || row.slack_channel_id !== actor.channel || row.slack_ts !== messageTs) {
    console.warn(`[content/decide] ${decision} refused for draft ${draftId}: stale_card`)
    await ephemeral(bot.token, actor, 'This draft is out of date; nothing was changed.')
    return 'refused'
  }
  const updated = await decideDraft(draftId, decision === 'skip' ? 'skipped' : 'superseded', actor.user)
  if (!updated) {
    await render(bot.token, (await getDraft(draftId)) ?? row)
    return 'already'
  }
  await render(bot.token, updated)
  if (decision === 'redo') {
    const res = await generateDraft({ now: new Date(), slot: row.slot, variant: row.variant, trigger: 'redo', redoOf: row.id }, liveDeps())
    if (res.status !== 'accepted') await ephemeral(bot.token, actor, `Redo didn't produce a draft that passes the rules (${(res.reason ?? '').slice(0, 300)}).`)
    else if (res.slack === 'dry_run') await ephemeral(bot.token, actor, 'Redo stored a new draft, but dry_run is on, so it was not posted here.')
    else if (typeof res.slack === 'object') await ephemeral(bot.token, actor, `Redo stored a new draft but posting failed (${res.slack.error}).`)
  }
  return 'done'
}
