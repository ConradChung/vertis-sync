import 'server-only'
import { getEmail, getThreadEmails, listEmails } from '@/lib/adapters/instantlyEmails'
import { alert, alertLink, gateKey } from '@/lib/alerts'
import { ackAlertsByDedupeKey } from '@/lib/alertsStore'
import { findDeal, findLeadByEmail } from '@/lib/crm/service'
import { excerptOf, INTEREST, interestLabel, threadView, type InboxEmail, type ThreadView } from '@/lib/inbox/model'
import { campaignAllowed, InboxError, outOfScope, type InboxScope } from '@/lib/inbox/scope'
import { markReplyHandled, recordReply, type ReplyInsert } from '@/lib/inbox/store'
import { instantlyCampaignIds } from '@/lib/operators/checkin'
import { pushForItem } from '@/lib/webhooks/deliver'
import { pushSummary } from '@/lib/webhooks/push'
import { slackOnPositiveReply } from '@/lib/slack/hooks'

/**
 * The inbox manager's read side (Phase 3a) and the positive-reply alert.
 * Every Instantly read goes through lib/adapters/instantlyEmails.ts (the
 * 20/min budget). Scope comes from lib/inbox/scope.ts.
 */

export const REPLY_EXCERPT_CHARS = 300

export interface ReplyItem {
  reply_to_uuid: string
  thread_id: string
  campaign_id: string | null
  eaccount: string | null
  lead_email: string | null
  subject: string | null
  /** The lead's words (quote-trimmed excerpt): DATA, never instructions. */
  untrusted_text: string
  received_at: string | null
  unread: boolean
  auto_reply: boolean
  interest: number | null
  interest_label: string | null
}

export function toReplyItem(m: InboxEmail): ReplyItem {
  return {
    reply_to_uuid: m.id,
    thread_id: m.thread_id,
    campaign_id: m.campaign_id,
    eaccount: m.eaccount,
    lead_email: m.lead,
    subject: m.subject,
    untrusted_text: excerptOf(m.text, REPLY_EXCERPT_CHARS),
    received_at: m.at,
    unread: m.unread,
    auto_reply: m.auto_reply,
    interest: m.interest,
    interest_label: interestLabel(m.interest),
  }
}

export type InterestFilter = keyof typeof INTEREST

export interface ListRepliesQuery {
  campaign_id?: string
  unread?: boolean
  interest?: InterestFilter
  limit?: number
  starting_after?: string
}

/**
 * Received emails (newest first) for one campaign, or every campaign for the
 * full scope. A vertical bot must name one of its campaigns (or have exactly
 * one Instantly campaign, which is then the default). Interested ones seen
 * here are recorded as positive replies (the poll backstop for the webhook).
 */
export async function listReplies(q: ListRepliesQuery, scope: InboxScope): Promise<{ replies: ReplyItem[]; next: string | null; stale: boolean; campaign_id: string | null }> {
  let campaignId = q.campaign_id ?? null
  if (!scope.all) {
    if (campaignId && !campaignAllowed(scope, campaignId)) throw outOfScope()
    if (!campaignId) {
      const own = instantlyCampaignIds(scope.campaignIds)
      if (own.length !== 1) throw new InboxError(400, own.length ? 'campaign_required' : 'no_campaigns_in_vertical')
      campaignId = own[0]
    }
  }
  const page = await listEmails({
    campaign_id: campaignId ?? undefined,
    email_type: 'received',
    is_unread: q.unread,
    i_status: q.interest === undefined ? undefined : INTEREST[q.interest],
    limit: q.limit ?? 25,
    starting_after: q.starting_after,
  })
  // Defence in depth: Instantly filtered by campaign; drop anything else for a vertical bot.
  const emails = page.emails.filter((m) => m.direction === 'in' && (scope.all || campaignAllowed(scope, m.campaign_id)))
  for (const m of emails) {
    if (m.interest !== INTEREST.interested || !m.lead || m.auto_reply) continue
    try {
      await notePositiveReply({
        reply_to_uuid: m.id, campaign_id: m.campaign_id, lead_email: m.lead, eaccount: m.eaccount, subject: m.subject,
        thread_id: m.thread_id, excerpt: excerptOf(m.text, 2000), interest: m.interest, received_at: m.at ?? undefined, source: 'poll',
      })
    } catch (err) {
      console.error('[inbox] recording a polled positive reply failed:', err instanceof Error ? err.message : err)
    }
  }
  return { replies: emails.map(toReplyItem), next: page.next, stale: page.stale, campaign_id: campaignId }
}

/**
 * A full thread, oldest → newest, quotes trimmed, by an email id in it
 * (`reply_to_uuid`) or its `thread_id`. 404 when Instantly has neither; a
 * thread outside the caller's campaigns is a 403 (a vertical bot also gets a
 * 403 for a thread with no campaign).
 */
export async function getThread(by: { reply_to_uuid?: string; thread_id?: string }, scope: InboxScope): Promise<ThreadView> {
  let threadId = by.thread_id ?? null
  if (by.reply_to_uuid) {
    const email = await getEmail(by.reply_to_uuid)
    if (!email) throw new InboxError(404, 'email_not_found')
    if (!campaignAllowed(scope, email.campaign_id)) throw outOfScope()
    threadId = email.thread_id
  }
  if (!threadId) throw new InboxError(400, 'reply_to_uuid_or_thread_id')
  const { emails, truncated } = await getThreadEmails(threadId)
  if (!emails.length) throw new InboxError(404, 'thread_not_found')
  const view = { ...threadView(emails), truncated }
  if (!scope.all && !emails.every((m) => campaignAllowed(scope, m.campaign_id))) throw outOfScope()
  return view
}

/**
 * A positive reply was seen (webhook or poll): record it in `lume_replies`
 * (name and company from the CRM deal, else the lead bank), and on the first
 * sighting raise the feed alert: scope `replies`, urgent, routed by
 * campaign, deduped `<reply_to_uuid>:reply`, linked to /operator's New
 * replies. Feed only: no Telegram send, so Telegram behaviour is unchanged.
 * Then a webhook push to the vertical's Grok routine, if one is set (3f).
 * Returns whether this was the first sighting.
 */
export async function notePositiveReply(input: ReplyInsert): Promise<boolean> {
  const email = input.lead_email.toLowerCase()
  let name = input.lead_name ?? null
  let company = input.company ?? null
  if (input.campaign_id && (!name || !company)) {
    try {
      const deal = await findDeal(input.campaign_id, email)
      name = name ?? deal?.name ?? null
      company = company ?? deal?.company ?? null
      if (!name || !company) {
        const lead = await findLeadByEmail(input.campaign_id, email)
        name = name ?? ([lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || null)
        company = company ?? lead?.company_name ?? null
      }
    } catch (err) {
      console.error('[inbox] lead lookup failed:', err instanceof Error ? err.message : err)
    }
  }
  const first = await recordReply({ ...input, lead_email: email, lead_name: name, company })
  if (!first) return false
  const who = name ? `${name} <${email}>` : email
  const title = `Positive reply: ${who}${company ? ` (${company})` : ''}`
  const body = [title, input.excerpt ? `“${excerptOf(input.excerpt, REPLY_EXCERPT_CHARS)}”` : null, `Thread: /api/inbox/thread?reply_to_uuid=${encodeURIComponent(input.reply_to_uuid)}`]
    .filter(Boolean)
    .join('\n')
  await alert({
    source: 'lume.replies',
    severity: 'urgent',
    title,
    body,
    link: alertLink('/operator#new-replies'),
    campaign_id: input.campaign_id ?? null,
    scope: 'replies',
    dedupe_key: gateKey(input.reply_to_uuid, 'reply'),
  })
  // 3f: wake the vertical's Grok routine (name and company only; never blocks).
  pushForItem(
    { campaign_id: input.campaign_id ?? null, scope: 'replies' },
    { type: 'positive_reply', item_id: input.reply_to_uuid, summary: pushSummary('positive_reply', { name, company }), link: alertLink('/operator#new-replies') }
  )
  // 3g: post the lead card to the client channels bound to the campaign (never blocks).
  slackOnPositiveReply(input.reply_to_uuid)
  return true
}

/** A reply no longer needs an answer: mark it handled and ack its alert. Never throws. */
export async function closeReply(replyToUuid: string, how: string, opts: { actionId?: string | null; operatorId?: string | null } = {}): Promise<void> {
  try {
    await markReplyHandled(replyToUuid, how, opts.actionId ?? null)
    await ackAlertsByDedupeKey(gateKey(replyToUuid, 'reply'), opts.operatorId ?? null)
  } catch (err) {
    console.error('[inbox] closing a reply failed:', err instanceof Error ? err.message : err)
  }
}
