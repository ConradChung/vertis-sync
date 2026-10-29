import 'server-only'
import { claimClientDecision, getAction, saveClientEdit } from '@/lib/actions/store'
import { scheduleExecution } from '@/lib/actions/grant'
import { parseCampaignPayload } from '@/lib/actions/payloads'
import { alert, alertLink } from '@/lib/alerts'
import { logEvent } from '@/lib/db/service'
import type { PendingActionRow } from '@/lib/db/types'
import { looksLikeOptOut } from '@/lib/inbox/replyMode'
import { getReplyMode } from '@/lib/inbox/replyModeStore'
import { listVerticals } from '@/lib/operators/store'
import { routeItemForAction } from '@/lib/operators/route'
import { slackApi } from '@/lib/slack/api'
import { channelCoversCampaign } from '@/lib/slack/binding'
import { buildEditModal, type CardMode } from '@/lib/slack/card'
import { CLIENT_REFUSAL_TEXT, clientDecisionError, type ClientDecision, type ClientRefusal } from '@/lib/slack/policy'
import { refreshPost, storedFacts } from '@/lib/slack/post'
import { getBinding, getBotToken, getInstall, getPost, getPostByTs, type PostRow } from '@/lib/slack/store'
import { pushForItem } from '@/lib/webhooks/deliver'
import { pushSummary } from '@/lib/webhooks/push'

/**
 * A client's Approve / Edit / Skip in Slack (3g), run after the
 * interactions route has verified the signature and answered Slack.
 *
 * Everything is re-read at click time: the post (by workspace + channel +
 * message ts, and it must point at the clicked action), the action, the
 * channel's binding and install, the campaign's mode. lib/slack/policy.ts
 * decides; the claim is the same conditional PATCH every other approver
 * races on (claimClientDecision, decided_via 'client' + Slack user + team).
 * An approved reply then goes through the executor with every live re-check
 * plus the client re-check (lib/slack/clientCheck.ts). Refusals are told to
 * the clicking user only (chat.postEphemeral), and the post is refreshed so
 * stale buttons disappear.
 */

export interface SlackActor {
  team: string
  user: string
  channel: string
}

type Checked = { ok: true; post: PostRow; action: PendingActionRow; token: string } | { ok: false; refusal: ClientRefusal | 'stale_post'; post: PostRow | null; action: PendingActionRow | null; token: string | null }

/** Values the caller already read (in parallel); anything absent is read here. */
interface Prefetched {
  bot?: { token: string } | null
  action?: PendingActionRow | null
}

async function check(actor: SlackActor, post: PostRow | null, actionId: string | null, decision: ClientDecision, pre: Prefetched = {}): Promise<Checked> {
  const bot = pre.bot !== undefined ? pre.bot : await getBotToken(actor.team)
  if (!post || post.team_id !== actor.team || post.channel_id !== actor.channel || !actionId || post.action_id !== actionId) {
    return { ok: false, refusal: 'stale_post', post, action: null, token: bot?.token ?? null }
  }
  const action = pre.action !== undefined ? pre.action : await getAction(actionId)
  if (!action || !bot) return { ok: false, refusal: 'already_decided', post, action, token: bot?.token ?? null }
  const campaign = typeof action.payload?.campaign_id === 'string' ? action.payload.campaign_id : null
  const sameReply = action.payload?.reply_to_uuid === post.reply_to_uuid
  const [binding, install, verticals, mode] = await Promise.all([
    getBinding(actor.team, actor.channel),
    getInstall(actor.team),
    listVerticals(),
    campaign ? getReplyMode(campaign) : Promise.resolve<CardMode>('owner'),
  ])
  const covered = sameReply && !!binding && !!install && !install.revoked_at && channelCoversCampaign(binding, verticals, campaign)
  const theirs = typeof action.payload?.their_message === 'string' ? action.payload.their_message : null
  const optOut = storedFacts(post.card).optOut || looksLikeOptOut(theirs)
  const refusal = clientDecisionError({ decision, slackUser: actor.user, action, covered, mode, optOut })
  if (refusal) return { ok: false, refusal, post, action, token: bot.token }
  return { ok: true, post, action, token: bot.token }
}

async function tell(token: string | null, actor: SlackActor, text: string): Promise<void> {
  if (!token) return
  try {
    await slackApi('chat.postEphemeral', token, { channel: actor.channel, user: actor.user, text })
  } catch (err) {
    console.error('[slack/decide] ephemeral failed:', err instanceof Error ? err.message : err)
  }
}

async function refresh(post: PostRow | null, actionId: string | null): Promise<void> {
  if (!post) return
  try {
    const action = actionId ? await getAction(actionId) : null
    await refreshPost(post, action)
  } catch (err) {
    console.error('[slack/decide] refreshing the post failed:', err instanceof Error ? err.message : err)
  }
}

const refusalText = (r: ClientRefusal | 'stale_post') => (r === 'stale_post' ? 'This post is out of date; it has been refreshed.' : CLIENT_REFUSAL_TEXT[r])

/** Approve or Skip from a button. */
export async function clientButton(actor: SlackActor, messageTs: string, actionId: string, decision: 'approve' | 'skip'): Promise<'approved' | 'skipped' | 'refused'> {
  const post = await getPostByTs(actor.team, actor.channel, messageTs)
  const c = await check(actor, post, actionId, decision)
  if (!c.ok) {
    await tell(c.token, actor, refusalText(c.refusal))
    await refresh(c.post, c.post?.action_id ?? null)
    return 'refused'
  }
  const approve = decision === 'approve'
  const claimed = await claimClientDecision(actionId, approve, { team: actor.team, user: actor.user })
  if (!claimed) {
    const now = await getAction(actionId)
    await tell(c.token, actor, now?.edited_by_slack_user === actor.user && now.status === 'awaiting' ? CLIENT_REFUSAL_TEXT.self_edit : CLIENT_REFUSAL_TEXT.already_decided)
    await refresh(c.post, actionId)
    return 'refused'
  }
  const route = routeItemForAction(claimed)
  const summary = typeof claimed.payload?.summary === 'string' ? claimed.payload.summary : 'send_reply'
  const title = `${approve ? '✅ Approved' : '❌ Skipped'} by the client in Slack — send_reply`
  try {
    await logEvent({
      type: approve ? 'lume.reply_client_approved' : 'lume.reply_client_skipped',
      source: 'lume',
      source_id: claimed.id,
      title,
      payload: { decided_via: 'client', slack_team: actor.team, slack_user: actor.user, campaign_id: route.campaign_id ?? null },
    })
    // Feed only: Telegram stays exactly as it was.
    await alert({ source: 'lume.slack', severity: 'info', title, body: `${title}\n${summary}`, link: alertLink(`/actions/${claimed.id}`), campaign_id: route.campaign_id, scope: route.scope, owner_only: route.owner_only })
  } catch (err) {
    console.error('[slack/decide] audit failed:', err instanceof Error ? err.message : err)
  }
  await refresh(c.post, actionId)
  // The executor re-checks the live thread and the client approval, then refreshes the post itself.
  if (approve) scheduleExecution(claimed.id)
  return approve ? 'approved' : 'skipped'
}

export const EDIT_RETRY_TEXT = 'Slack took too long to open the editor. Please try again: press Edit once more.'

/**
 * Edit from a button: open the modal. The trigger id expires 3 s after the
 * click, so the post, the token and the action are read in parallel first;
 * if Slack still says the trigger expired, the user is told to try again.
 */
export async function clientOpenEdit(actor: SlackActor, messageTs: string, actionId: string, triggerId: string): Promise<boolean> {
  const [post, bot, action] = await Promise.all([getPostByTs(actor.team, actor.channel, messageTs), getBotToken(actor.team), getAction(actionId)])
  const c = await check(actor, post, actionId, 'edit', { bot, action })
  if (!c.ok) {
    await tell(c.token, actor, refusalText(c.refusal))
    await refresh(c.post, c.post?.action_id ?? null)
    return false
  }
  const body = typeof c.action.payload?.body === 'string' ? c.action.payload.body : ''
  try {
    await slackApi('views.open', c.token, { trigger_id: triggerId, view: buildEditModal(c.post.id, body) })
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'expired_trigger_id') {
      await tell(c.token, actor, EDIT_RETRY_TEXT)
      return false
    }
    throw err
  }
  return true
}

/**
 * The Edit modal was submitted: save the body as this user's draft. The
 * action stays awaiting, and this user can no longer approve it.
 */
export async function clientSaveEdit(actor: Omit<SlackActor, 'channel'>, postId: number, body: string): Promise<'saved' | 'unchanged' | 'refused'> {
  const post = await getPost(postId)
  const withChannel = { ...actor, channel: post?.channel_id ?? '' }
  const c = await check(withChannel, post, post?.action_id ?? null, 'edit')
  if (!c.ok) {
    await tell(c.token, withChannel, refusalText(c.refusal))
    await refresh(c.post, c.post?.action_id ?? null)
    return 'refused'
  }
  const p = c.action.payload ?? {}
  if (body.trim() === String(p.body ?? '').trim()) {
    await tell(c.token, withChannel, 'No changes: the reply is the same as before, so nothing was saved.')
    return 'unchanged'
  }
  const next = parseCampaignPayload(
    'send_reply',
    {
      ...p,
      body: body.trim(),
      original_body: typeof p.original_body === 'string' && p.original_body ? p.original_body : p.body,
      edited_by: `slack:${actor.team}:${actor.user}`,
      edited_at: new Date().toISOString(),
    },
    { trustSummary: false }
  )
  if (!next.ok) {
    await tell(c.token, withChannel, 'That reply could not be saved (empty or too long).')
    return 'refused'
  }
  const saved = await saveClientEdit(c.action.id, next.payload, actor.user)
  if (!saved) {
    await tell(c.token, withChannel, CLIENT_REFUSAL_TEXT.already_decided)
    await refresh(c.post, c.action.id)
    return 'refused'
  }
  const route = routeItemForAction(saved)
  const title = 'Client edited a reply in Slack; it awaits a second approval'
  try {
    await logEvent({ type: 'lume.reply_client_edited', source: 'lume', source_id: saved.id, title, payload: { slack_team: actor.team, slack_user: actor.user, campaign_id: route.campaign_id ?? null } })
    await alert({ source: 'lume.slack', severity: 'urgent', title, body: `${title}\n${String(saved.payload?.summary ?? '')}`, link: alertLink(`/actions/${saved.id}`), campaign_id: route.campaign_id, scope: route.scope, owner_only: route.owner_only })
  } catch (err) {
    console.error('[slack/decide] audit failed:', err instanceof Error ? err.message : err)
  }
  const sp = saved.payload ?? {}
  pushForItem(route, {
    type: 'draft_awaiting', item_id: saved.id, link: alertLink(`/actions/${saved.id}`),
    summary: pushSummary('draft_awaiting', { name: typeof sp.lead_name === 'string' ? sp.lead_name : null, company: typeof sp.company === 'string' ? sp.company : null }),
  })
  await refresh(c.post, saved.id)
  return 'saved'
}
