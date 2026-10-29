import 'server-only'
import { after } from 'next/server'
import { claimDecision } from '@/lib/actions/store'
import { logEvent } from '@/lib/db/service'
import type { Json, PendingActionRow } from '@/lib/db/types'
import { getReply, listLeadReplies } from '@/lib/inbox/store'
import { getEmail } from '@/lib/adapters/instantlyEmails'
import { trimQuotes, type InboxEmail } from '@/lib/inbox/model'
import { grantBlocker, type GrantBlocker } from '@/lib/inbox/replyMode'
import { getReplyMode } from '@/lib/inbox/replyModeStore'
import { canApproveSend } from '@/lib/operators/policy'

/**
 * The scoped send grant (inbox manager 3e): a campaign in Auto reply mode
 * approves its own send_reply rows, `decided_via='grant'`, the moment they are
 * created (lib/actions/create.ts). Nothing else approves a reply without a
 * person: send_reply stays in ALWAYS_ASK_KINDS, so skip mode never does.
 *
 * Policy (lib/operators/policy.ts canApproveSend): the grant is not an
 * operator, so the "no bot approves a reply it drafted" rule has nobody to
 * apply to; a bot's draft on an Auto campaign is sent by the grant, never
 * approved by that bot. The grant still calls canApproveSend(null, …) so a
 * future tightening of the policy for operator-less approvals applies here.
 *
 * Fail closed: any error reading the mode or the reply history leaves the
 * row awaiting a person, exactly as in Owner mode.
 */

const str = (v: Json | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Why this send_reply payload must wait for a person, or null when the grant
 * may approve it. `fresh` is the executor's uncached read of the answered
 * email; at creation the (cached) read is used. The opt-out check runs over
 * the email's full quote-trimmed text, not the card's 2000-character cut.
 */
export async function evaluateGrant(payload: Record<string, Json> | null, fresh?: InboxEmail | null): Promise<GrantBlocker | null> {
  const p = payload ?? {}
  const campaign = str(p.campaign_id)
  if (!campaign) return 'no_campaign'
  const mode = await getReplyMode(campaign)
  if (mode !== 'auto') return grantBlocker({ mode, payload: p, email: null, reply: null, leadReplies: [] })
  const lead = str(p.lead_email)
  if (!lead) return 'recipient_unverified'
  const replyTo = str(p.reply_to_uuid)
  const [email, reply, leadReplies] = await Promise.all([
    fresh !== undefined ? Promise.resolve(fresh) : replyTo ? getEmail(replyTo) : Promise.resolve(null),
    replyTo ? getReply(replyTo) : Promise.resolve(null),
    listLeadReplies(lead),
  ])
  const view = email ? { message: trimQuotes(email.text ?? ''), interest: email.interest ?? null, campaign_id: email.campaign_id ?? null } : null
  return grantBlocker({ mode, payload: p, email: view, reply, leadReplies })
}

export type GrantOutcome = { granted: true; row: PendingActionRow } | { granted: false; reason: GrantBlocker | 'policy' | 'already_decided' | 'error' }

export async function tryGrantSend(row: PendingActionRow): Promise<GrantOutcome> {
  if (row.kind !== 'send_reply') return { granted: false, reason: 'mode_owner' }
  let reason: GrantBlocker | null
  try {
    reason = await evaluateGrant(row.payload)
  } catch (err) {
    console.error('[grant] could not evaluate the reply grant; it waits for a person:', err instanceof Error ? err.message : err)
    return { granted: false, reason: 'error' }
  }
  if (reason) return { granted: false, reason }
  if (!canApproveSend(null, row)) return { granted: false, reason: 'policy' }
  let claimed: PendingActionRow | null
  try {
    claimed = await claimDecision(row.id, true, 'grant')
  } catch (err) {
    console.error('[grant] claim failed; it waits for a person:', err instanceof Error ? err.message : err)
    return { granted: false, reason: 'error' }
  }
  if (!claimed) return { granted: false, reason: 'already_decided' }
  try {
    await logEvent({
      type: 'lume.reply_auto_approved',
      source: 'lume',
      source_id: row.id,
      title: 'send_reply approved by the campaign’s Auto mode',
      payload: { campaign_id: str(row.payload?.campaign_id), reply_to_uuid: str(row.payload?.reply_to_uuid), decided_via: 'grant' },
    })
  } catch (err) {
    console.error('[grant] logEvent failed:', err instanceof Error ? err.message : err)
  }
  scheduleExecution(row.id)
  return { granted: true, row: claimed }
}

/**
 * Run the executor after the response (`after()`); outside a request scope it
 * starts at once without being awaited. If the function is cut first, the row
 * stays `approved` and the sweeper re-dispatches it (SWEEP_AFTER_MS).
 */
export function scheduleExecution(id: string): void {
  const job = async () => {
    try {
      const { executeAction } = await import('@/lib/actions/execute')
      await executeAction(id)
    } catch (err) {
      console.error('[grant] executing the auto-approved reply failed:', err instanceof Error ? err.message : err)
    }
  }
  try {
    after(job)
  } catch {
    void job()
  }
}

/**
 * The executor's last look at a grant (decided_via 'grant'), right before the
 * send, against its fresh read of the answered email: the campaign must still
 * be in Auto mode and nothing since may hold it (a label, an out-of-office or
 * negative interest, an opt-out in the text). Null when it still holds.
 */
export async function grantStillHolds(action: Pick<PendingActionRow, 'payload'>, answered?: InboxEmail | null): Promise<GrantBlocker | null> {
  return evaluateGrant(action.payload, answered)
}
