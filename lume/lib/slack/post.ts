import 'server-only'
import { getAction } from '@/lib/actions/store'
import { BLOCKING_REPLY_STATUSES } from '@/lib/actions/create'
import { findAwaitingActionBy } from '@/lib/campaigns/service'
import type { Json, PendingActionRow } from '@/lib/db/types'
import { getReply } from '@/lib/inbox/store'
import { looksLikeOptOut, parseReplyMode } from '@/lib/inbox/replyMode'
import { getReplyMode } from '@/lib/inbox/replyModeStore'
import { listVerticals } from '@/lib/operators/store'
import { slackApi } from '@/lib/slack/api'
import { channelCoversCampaign, type ChannelBinding } from '@/lib/slack/binding'
import { buildCard, CARD_FIELDS, parseVisibleFields, type CardInput, type DraftState, type LeadFacts } from '@/lib/slack/card'
import { isSlackConfigured } from '@/lib/slack/config'
import { gatherFacts } from '@/lib/slack/facts'
import { claimPost, getBotToken, getBinding, listBindings, listInstalls, listPostsForReply, releasePost, updatePost, type PostRow } from '@/lib/slack/store'

/**
 * Posting to client channels (3g).
 *
 *  - postReplyToChannels: a positive reply was first recorded
 *    (lib/inbox/replies.ts notePositiveReply). Every active channel whose
 *    binding covers the reply's campaign gets one post (lume_slack_posts is
 *    the dedupe, claimed before chat.postMessage).
 *  - syncAction: a send_reply was drafted, edited, decided or executed. Each
 *    post of its reply is rebuilt and replaced with chat.update.
 *
 * The facts the post was built from are kept on the row (`card`), so updates
 * never re-read them and a later edit of the CRM cannot change what was
 * shown. The binding (visible fields), the campaign's mode and the action
 * are read fresh on every update. Never throws to the caller (lib/slack/hooks.ts).
 */

const ACTION_STATUSES = new Set(['awaiting', 'approved', 'executing', 'executed', 'rejected', 'failed', 'expired'])

export function draftOf(a: PendingActionRow | null): DraftState {
  if (!a || a.kind !== 'send_reply' || !ACTION_STATUSES.has(a.status)) return { kind: 'none' }
  const p = a.payload ?? {}
  const result = (a.result ?? {}) as Record<string, Json>
  const code = a.status === 'failed' ? (Object.keys(result).find((k) => result[k] === true && /^[a-z_]+$/.test(k)) ?? null) : null
  return {
    kind: 'action',
    action_id: a.id,
    status: a.status as Extract<DraftState, { kind: 'action' }>['status'],
    body: typeof p.body === 'string' ? p.body : '',
    decided_via: a.decided_via,
    decided_by_slack_user: a.decided_by_slack_user ?? null,
    edited_by_slack_user: a.edited_by_slack_user ?? null,
    error_code: code,
  }
}

/** The facts stored on a post, read back defensively. */
export function storedFacts(card: Record<string, Json> | null | undefined): { facts: LeadFacts; optOut: boolean } {
  const c = card ?? {}
  const facts = Object.fromEntries(CARD_FIELDS.map((f) => [f, typeof c[f] === 'string' ? (c[f] as string) : null])) as LeadFacts
  return { facts, optOut: c.opt_out === true }
}

function cardInput(facts: LeadFacts, optOut: boolean, binding: ChannelBinding | null, mode: CardInput['mode'], action: PendingActionRow | null): CardInput {
  const theirs = typeof action?.payload?.their_message === 'string' ? action.payload.their_message : null
  return {
    facts,
    visible: parseVisibleFields(binding?.visible_fields),
    mode,
    optOut: optOut || looksLikeOptOut(theirs),
    draft: draftOf(action),
  }
}

/** The newest send_reply for a reply in any blocking state (awaiting … executed), else the newest at all. */
async function currentAction(replyToUuid: string): Promise<PendingActionRow | null> {
  return (
    (await findAwaitingActionBy('send_reply', 'reply_to_uuid', replyToUuid, BLOCKING_REPLY_STATUSES)) ??
    (await findAwaitingActionBy('send_reply', 'reply_to_uuid', replyToUuid, ['rejected', 'failed', 'expired']))
  )
}

/** Post a recorded positive reply to every bound channel that has not had it. Returns how many were posted. */
export async function postReplyToChannels(replyToUuid: string): Promise<number> {
  if (!isSlackConfigured()) return 0
  const reply = await getReply(replyToUuid)
  if (!reply?.campaign_id) return 0
  const [bindings, installs, verticals] = await Promise.all([listBindings({ activeOnly: true }), listInstalls(), listVerticals()])
  const live = new Set(installs.filter((i) => !i.revoked_at).map((i) => i.team_id))
  const targets = bindings.filter((b) => channelCoversCampaign(b, verticals, reply.campaign_id, live.has(b.team_id)))
  if (!targets.length) return 0
  const [facts, mode, action] = await Promise.all([gatherFacts(reply), getReplyMode(reply.campaign_id), currentAction(replyToUuid)])
  const optOut = looksLikeOptOut(reply.excerpt)
  const stored: Record<string, Json> = { ...facts, opt_out: optOut, campaign_id: reply.campaign_id }
  let posted = 0
  for (const b of targets) {
    try {
      const row = await claimPost({ reply_to_uuid: replyToUuid, team_id: b.team_id, channel_id: b.channel_id, card: stored, action_id: action?.id ?? null })
      if (!row) continue
      const bot = await getBotToken(b.team_id)
      if (!bot) {
        await releasePost(row.id)
        continue
      }
      const msg = buildCard(cardInput(facts, optOut, b, mode, action))
      try {
        const res = await slackApi('chat.postMessage', bot.token, { channel: b.channel_id, ...msg, unfurl_links: false, unfurl_media: false })
        await updatePost(row.id, { ts: typeof res.ts === 'string' ? res.ts : null })
        posted++
      } catch (err) {
        await releasePost(row.id).catch(() => {})
        throw err
      }
    } catch (err) {
      console.error(`[slack/post] posting to ${b.team_id}/${b.channel_id} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return posted
}

/** Rebuild one post from its stored facts and the action, and chat.update it. */
export async function refreshPost(post: PostRow, action: PendingActionRow | null): Promise<void> {
  if (!post.ts) return
  const bot = await getBotToken(post.team_id)
  if (!bot) return
  const binding = await getBinding(post.team_id, post.channel_id)
  // An unbound or paused channel is left as it is (never re-rendered with default fields).
  if (!binding?.active) return
  const campaign = typeof post.card.campaign_id === 'string' ? post.card.campaign_id : typeof action?.payload?.campaign_id === 'string' ? action.payload.campaign_id : null
  const mode = campaign ? await getReplyMode(campaign) : parseReplyMode(null)
  const { facts, optOut } = storedFacts(post.card)
  const msg = buildCard(cardInput(facts, optOut, binding, mode, action))
  await slackApi('chat.update', bot.token, { channel: post.channel_id, ts: post.ts, ...msg })
}

/**
 * A send_reply changed (drafted, edited, decided, executed): point every post
 * of its reply at it and refresh them. A reply never posted yet (the draft
 * came first) is posted now.
 */
export async function syncAction(actionId: string): Promise<void> {
  if (!isSlackConfigured()) return
  const action = await getAction(actionId)
  if (!action || action.kind !== 'send_reply') return
  const replyTo = typeof action.payload?.reply_to_uuid === 'string' ? action.payload.reply_to_uuid : null
  if (!replyTo) return
  let posts = await listPostsForReply(replyTo)
  if (!posts.length) {
    await postReplyToChannels(replyTo)
    posts = await listPostsForReply(replyTo)
  }
  for (const post of posts) {
    try {
      // A newer draft for the same reply takes the post over; an older one does not.
      if (post.action_id !== action.id) {
        const current = post.action_id ? await getAction(post.action_id) : null
        if (current && current.created_at > action.created_at) continue
        await updatePost(post.id, { action_id: action.id })
        post.action_id = action.id
      }
      await refreshPost(post, action)
    } catch (err) {
      console.error(`[slack/post] updating ${post.team_id}/${post.channel_id} failed:`, err instanceof Error ? err.message : err)
    }
  }
}
