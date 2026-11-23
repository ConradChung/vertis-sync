import 'server-only'
import { slackApi } from '@/lib/slack/api'
import { buildSignalCard, buildSignalEditModal, type SignalDrafts } from '@/lib/slack/signalCard'
import { getBotToken } from '@/lib/slack/store'
import { signalCardOpts } from '@/lib/signal/config'
import { decideSignalPerson, getSignalConfig, getSignalPerson, getSignalPost, type SignalPerson } from '@/lib/signal/store'

/**
 * GTM-14: Approve / Edit / Skip on a #sales signal card, run after the
 * interactions route verified Slack's signature. Nothing is sent to anyone:
 * Approve only records the decision (Frank copies the draft by hand).
 *
 * The click must come from the workspace and channel in signal_config.slack
 * and match the row's posted message. Each decision is a conditional update
 * from the states it may come from (posted / edited), so a double click or a
 * second teammate finds nothing to do and the card is just re-rendered.
 */

export interface SignalActor {
  team: string
  user: string
  channel: string
}

const OPEN = ['posted', 'edited'] as const

async function tell(token: string, actor: SignalActor, text: string): Promise<void> {
  try {
    await slackApi('chat.postEphemeral', token, { channel: actor.channel, user: actor.user, text })
  } catch (err) {
    console.error('[slack/signalDecide] ephemeral failed:', err instanceof Error ? err.message : err)
  }
}

async function render(token: string, row: SignalPerson): Promise<void> {
  if (!row.slack_channel_id || !row.slack_ts) return
  const post = row.post_id ? await getSignalPost(row.post_id) : null
  const card = buildSignalCard(row, { ...signalCardOpts(), post })
  await slackApi('chat.update', token, { channel: row.slack_channel_id, ts: row.slack_ts, text: card.text, blocks: card.blocks })
}

type Loaded = { ok: true; row: SignalPerson; token: string } | { ok: false; reason: string; token: string | null }

async function load(actor: { team: string; channel?: string }, personId: number, messageTs: string | null): Promise<Loaded> {
  const [cfg, row, bot] = await Promise.all([getSignalConfig(), getSignalPerson(personId), getBotToken(actor.team)])
  const token = bot?.token ?? null
  if (!bot) return { ok: false, reason: 'no_install', token }
  if (cfg.slack.team_id !== actor.team || (actor.channel !== undefined && cfg.slack.channel_id !== actor.channel)) return { ok: false, reason: 'wrong_channel', token }
  if (!row || row.kind !== 'commenter' || row.slack_team_id !== actor.team || row.slack_channel_id !== cfg.slack.channel_id) return { ok: false, reason: 'stale_card', token }
  if (messageTs !== null && row.slack_ts !== messageTs) return { ok: false, reason: 'stale_card', token }
  return { ok: true, row, token: bot.token }
}

export async function signalButton(actor: SignalActor, messageTs: string, personId: number, decision: 'approve' | 'skip'): Promise<'done' | 'already' | 'refused'> {
  const l = await load(actor, personId, messageTs)
  if (!l.ok) {
    console.warn(`[slack/signalDecide] ${decision} refused for person ${personId}: ${l.reason}`)
    if (l.token && l.reason !== 'wrong_channel') await tell(l.token, actor, 'This card is out of date; nothing was changed.')
    return 'refused'
  }
  const updated = await decideSignalPerson(personId, OPEN, { alert_status: decision === 'approve' ? 'approved' : 'skipped', decided_by: actor.user })
  if (!updated) {
    // Already decided (double click, or a teammate): show the current state.
    const cur = (await getSignalPerson(personId)) ?? l.row
    await render(l.token, cur)
    return 'already'
  }
  await render(l.token, updated)
  return 'done'
}

export async function signalOpenEdit(actor: SignalActor, messageTs: string, personId: number, triggerId: string): Promise<'opened' | 'refused'> {
  const l = await load(actor, personId, messageTs)
  if (!l.ok) {
    if (l.token && l.reason !== 'wrong_channel') await tell(l.token, actor, 'This card is out of date; nothing was changed.')
    return 'refused'
  }
  if (!OPEN.includes(l.row.alert_status as (typeof OPEN)[number])) {
    await tell(l.token, actor, 'This card was already decided; the drafts can no longer be edited here.')
    return 'refused'
  }
  if (!triggerId) return 'refused'
  await slackApi('views.open', l.token, { trigger_id: triggerId, view: buildSignalEditModal(l.row, signalCardOpts().noteLimit) })
  return 'opened'
}

export async function signalSaveEdit(actor: { team: string; user: string }, personId: number, drafts: SignalDrafts): Promise<'saved' | 'refused'> {
  const l = await load({ team: actor.team }, personId, null)
  if (!l.ok) {
    console.warn(`[slack/signalDecide] edit refused for person ${personId}: ${l.reason}`)
    return 'refused'
  }
  const clean: SignalDrafts = {}
  for (const [k, v] of Object.entries(drafts)) clean[k as keyof SignalDrafts] = typeof v === 'string' && v.trim() ? v.trim() : null
  const updated = await decideSignalPerson(personId, OPEN, { alert_status: 'edited', decided_by: actor.user, drafts: clean })
  if (!updated) return 'refused'
  await render(l.token, updated)
  return 'saved'
}
