import 'server-only'
import { createAction, DuplicateActionError } from '@/lib/actions/create'
import { getEmail } from '@/lib/adapters/instantlyEmails'
import { addToBlocklist, leadInCampaign, setInterestStatus } from '@/lib/adapters/instantlyLabels'
import { claimDecision, listAwaitingReplyActions } from '@/lib/actions/store'
import { slackOnAction } from '@/lib/slack/hooks'
import { addActivity, ensureDeal, setStage } from '@/lib/crm/service'
import type { ActivitySource } from '@/lib/crm/types'
import { logEvent } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { labelPlan, type LabelPlan } from '@/lib/inbox/model'
import { closeReply } from '@/lib/inbox/replies'
import type { BookingInput, LabelInput } from '@/lib/inbox/schemas'
import { campaignAllowed, InboxError, outOfScope, type InboxScope } from '@/lib/inbox/scope'
import { markLeadRepliesHandled } from '@/lib/inbox/store'

/**
 * label_reply and log-booking (inbox manager 3b / 3c). Low tier: nothing is
 * sent to the lead. In order:
 *  1. resolve the lead and campaign (from the reply's email, else as given:
 *     then Instantly must confirm the lead is in that campaign before any
 *     write) and check the caller's scope;
 *  2. Instantly: the interest status, then the blocklist (unsubscribe,
 *     hostile, BAD + block). If Instantly fails, the CRM is not touched;
 *  2b. a label that blocks, closes or handles denies every awaiting
 *     send_reply for that reply and lead, so no stale draft can be approved;
 *  3. CRM: the deal (created at Contacted when missing) moves to the plan's
 *     stage directly (never out of Won / Lost); a Lost close is filed as a
 *     `crm_close_deal` pending action for approval (one per deal); a meeting
 *     activity for bookings; a note recording the label and who set it;
 *  4. a label that means no reply is owed closes the reply in New replies;
 *  5. a `lume.reply_labeled` / `lume.booking_logged` event for the feed.
 */

export interface LabelOutcome {
  lead_email: string
  campaign_id: string
  category: string | null
  verdict: string | null
  /** The Instantly interest value set, or 'unchanged'. */
  interest: number | 'unchanged'
  blocked: boolean
  deal_id: string
  stage: { from: string; to: string } | null
  close_action_id: string | null
  meeting: boolean
  handled: boolean
  /** Awaiting send_reply drafts this label denied. */
  denied_drafts: string[]
}

const CLOSED = new Set(['Won', 'Lost'])

async function resolveTarget(input: { reply_to_uuid?: string; lead_email?: string; campaign_id?: string }, scope: InboxScope) {
  let lead = input.lead_email?.toLowerCase() ?? null
  let campaign = input.campaign_id ?? null
  if (input.reply_to_uuid) {
    const email = await getEmail(input.reply_to_uuid)
    if (!email) throw new InboxError(404, 'email_not_found')
    if (email.direction !== 'in') throw new InboxError(400, 'not_an_inbound_email')
    lead = email.lead ?? lead
    campaign = email.campaign_id ?? campaign
  }
  if (!lead || !campaign) throw new InboxError(400, 'lead_or_campaign_unknown')
  if (!campaignAllowed(scope, campaign)) throw outOfScope()
  // Named by address: prove it is this campaign's lead before writing anything.
  if (!input.reply_to_uuid && !(await leadInCampaign(lead, campaign))) throw new InboxError(400, 'lead_not_in_campaign')
  return { lead, campaign }
}

const sourceFor = (actor: string): ActivitySource => (actor === 'owner' ? 'user' : 'agent')

async function apply(
  target: { lead: string; campaign: string; reply_to_uuid?: string },
  plan: LabelPlan,
  meta: { category: string | null; verdict: string | null; note?: string; actor: string; via: 'label_reply' | 'log_booking'; meeting?: Record<string, Json>; meetingKey?: string | null }
): Promise<LabelOutcome> {
  const { lead, campaign } = target
  // 2. Instantly first: a failure here leaves the CRM as it was.
  if (plan.interest !== undefined) await setInterestStatus(lead, campaign, plan.interest)
  let blocked = false
  if (plan.block) {
    await addToBlocklist(lead)
    blocked = true
  }

  // 2b. No stale reply may go out after this label.
  const denied: string[] = []
  if (plan.block || plan.close || plan.handled) {
    const via = meta.actor === 'owner' ? 'lume' : meta.actor === 'agent' ? 'agent' : 'operator'
    const opId = meta.actor.startsWith('operator:') ? meta.actor.slice(9) : undefined
    for (const a of await listAwaitingReplyActions(campaign, lead, target.reply_to_uuid ?? null)) {
      if (await claimDecision(a.id, false, via, opId)) {
        denied.push(a.id)
        slackOnAction({ id: a.id, kind: 'send_reply' })
      }
    }
  }

  // 3. CRM
  const source = sourceFor(meta.actor)
  const deal = await ensureDeal({ campaign_id: campaign, email: lead, source: 'instantly' })
  const label = meta.category ?? (meta.verdict === 'BAD' ? 'bad_fit' : 'label')
  let stage: LabelOutcome['stage'] = null
  if (plan.stage && deal.stage !== plan.stage && !CLOSED.has(deal.stage)) {
    const from = await setStage(deal.id, plan.stage, source, null, { via: meta.via, category: label, by: meta.actor })
    if (from !== null) stage = { from, to: plan.stage }
  }
  let closeId: string | null = null
  if (plan.close && !CLOSED.has(deal.stage)) {
    const reason = `${label.replace(/_/g, ' ')}${meta.verdict ? ` (${meta.verdict})` : ''}${meta.note ? `: ${meta.note}` : ''}`.slice(0, 300)
    try {
      const a = await createAction(
        'crm_close_deal',
        { deal_id: deal.id, stage: plan.close, reason, campaign_id: campaign, lead_email: lead, ...(deal.name ? { lead_name: deal.name } : {}), summary: 'x' },
        source === 'user' ? 'user' : 'agent'
      )
      closeId = a.id
    } catch (err) {
      if (err instanceof DuplicateActionError) closeId = err.existingId || null
      else throw err
    }
  }
  if (plan.meeting && meta.meeting) {
    await addActivity({ deal_id: deal.id, kind: 'meeting', source, payload: meta.meeting, dedupe_key: meta.meetingKey ?? null })
  }
  const text = [
    meta.via === 'log_booking' ? 'Booking logged' : `Labeled ${label.replace(/_/g, ' ')}`,
    meta.verdict ? `(verdict ${meta.verdict})` : null,
    `by ${meta.actor}`,
    meta.note ? `— ${meta.note}` : null,
  ]
    .filter(Boolean)
    .join(' ')
  await addActivity({ deal_id: deal.id, kind: 'note', source, payload: { text, category: label, verdict: meta.verdict, by: meta.actor, via: meta.via } })

  // 4. No reply owed any more: out of New replies.
  if (plan.handled) {
    const how = meta.via === 'log_booking' ? 'booked' : `label:${label}`
    if (target.reply_to_uuid) await closeReply(target.reply_to_uuid, how, { operatorId: meta.actor.startsWith('operator:') ? meta.actor.slice(9) : null })
    try {
      const others = await markLeadRepliesHandled(campaign, lead, how)
      for (const id of others) if (id !== target.reply_to_uuid) await closeReply(id, how)
    } catch (err) {
      console.error('[inbox/label] closing the lead\'s other replies failed:', err instanceof Error ? err.message : err)
    }
  }

  const out: LabelOutcome = {
    lead_email: lead,
    campaign_id: campaign,
    category: meta.category,
    verdict: meta.verdict,
    interest: plan.interest === undefined ? 'unchanged' : plan.interest,
    blocked,
    deal_id: deal.id,
    stage,
    close_action_id: closeId,
    meeting: plan.meeting,
    handled: plan.handled,
    denied_drafts: denied,
  }
  try {
    await logEvent({
      type: meta.via === 'log_booking' ? 'lume.booking_logged' : 'lume.reply_labeled',
      source: 'lume',
      source_id: deal.id,
      campaign_id: campaign,
      lead_email: lead,
      title: meta.via === 'log_booking' ? `Booked: ${lead}` : `Label: ${lead} → ${label}${blocked ? ' (blocked)' : ''}`,
      payload: { ...out, by: meta.actor, ...(target.reply_to_uuid ? { reply_to_uuid: target.reply_to_uuid } : {}) } as unknown as Record<string, Json>,
    })
  } catch (err) {
    console.error('[inbox/label] logEvent failed:', err instanceof Error ? err.message : err)
  }
  return out
}

export async function applyLabel(input: LabelInput, scope: InboxScope, actor: string): Promise<LabelOutcome> {
  const plan = labelPlan(input)
  const t = await resolveTarget(input, scope)
  return apply({ ...t, reply_to_uuid: input.reply_to_uuid }, plan, {
    category: input.category ?? null,
    verdict: input.verdict ?? null,
    note: input.note,
    actor,
    via: 'label_reply',
  })
}

export async function logBooking(input: BookingInput, scope: InboxScope, actor: string): Promise<LabelOutcome> {
  const t = await resolveTarget(input, scope)
  const meeting: Record<string, Json> = {
    time: input.time,
    ...(input.event_id ? { event_id: input.event_id } : {}),
    ...(input.event_link ? { event_link: input.event_link } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    by: actor,
  }
  return apply({ ...t, reply_to_uuid: input.reply_to_uuid }, labelPlan({ category: 'booked' }), {
    category: 'booked',
    verdict: null,
    note: input.notes,
    actor,
    via: 'log_booking',
    meeting,
    meetingKey: input.event_id ? `booking:${t.campaign}:${input.event_id}` : null,
  })
}
