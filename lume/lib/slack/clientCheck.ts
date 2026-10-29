import 'server-only'
import type { PendingActionRow } from '@/lib/db/types'
import type { InboxEmail } from '@/lib/inbox/model'
import { trimQuotes } from '@/lib/inbox/model'
import { leadLabeledNegative, looksLikeOptOut } from '@/lib/inbox/replyMode'
import { listLeadReplies } from '@/lib/inbox/store'
import { getReplyMode } from '@/lib/inbox/replyModeStore'
import { listVerticals } from '@/lib/operators/store'
import { channelCoversCampaign } from '@/lib/slack/binding'
import { getInstall, listBindings } from '@/lib/slack/store'

/**
 * The executor's last look at a client's approval (decided_via 'client',
 * 3g), right before the send, against its fresh read of the answered email.
 * Like the Auto grant's re-check: the approval is only as good as the state
 * that allowed it, so it must all still hold:
 *  - the campaign is still in Client mode (the owner may have switched it);
 *  - the answered email is in that campaign;
 *  - the approver's workspace is still installed and has an active channel
 *    bound to the campaign;
 *  - the approver is not the editor of the body (also enforced at the claim);
 *  - the lead's full message is not a possible opt-out / hostile reply;
 *  - no other reply from the lead (any campaign) was labeled BAD,
 *    unsubscribe, hostile or not interested (the Auto grant's same rule,
 *    lib/inbox/replyMode.ts leadLabeledNegative).
 * Returns the refusal code, or null when the approval holds.
 */

export type ClientApprovalBlocker =
  | 'client_mode_revoked'
  | 'campaign_mismatch'
  | 'client_unbound'
  | 'client_self_edit'
  | 'opt_out_or_hostile'
  | 'lead_labeled_negative'

export const CLIENT_BLOCKER_TEXT: Record<ClientApprovalBlocker, string> = {
  client_mode_revoked: 'the campaign is no longer in Client approval mode',
  campaign_mismatch: "the answered email is not in the approved reply's campaign",
  client_unbound: "the approving workspace is no longer installed or bound to the campaign",
  client_self_edit: 'the approver edited this reply themselves',
  opt_out_or_hostile: 'the lead may have asked to stop or was hostile',
  lead_labeled_negative: 'the lead was labeled BAD, unsubscribe, hostile or not interested before (any campaign)',
}

export async function clientApprovalBlocker(
  action: Pick<PendingActionRow, 'payload' | 'decided_by_slack_team' | 'decided_by_slack_user' | 'edited_by_slack_user'>,
  answered: Pick<InboxEmail, 'campaign_id' | 'text'> & Partial<Pick<InboxEmail, 'lead'>>
): Promise<ClientApprovalBlocker | null> {
  const p = action.payload ?? {}
  const campaign = typeof p.campaign_id === 'string' ? p.campaign_id : null
  if (!campaign || answered.campaign_id !== campaign) return 'campaign_mismatch'
  if ((await getReplyMode(campaign)) !== 'client') return 'client_mode_revoked'
  if (action.edited_by_slack_user && action.edited_by_slack_user === action.decided_by_slack_user) return 'client_self_edit'
  const team = action.decided_by_slack_team
  if (!team) return 'client_unbound'
  const [install, bindings, verticals] = await Promise.all([getInstall(team), listBindings({ teamId: team, activeOnly: true }), listVerticals()])
  if (!install || install.revoked_at || !bindings.some((b) => channelCoversCampaign(b, verticals, campaign))) return 'client_unbound'
  const theirs = typeof p.their_message === 'string' ? p.their_message : ''
  if (looksLikeOptOut(trimQuotes(answered.text ?? '')) || looksLikeOptOut(theirs)) return 'opt_out_or_hostile'
  const lead = typeof p.lead_email === 'string' && p.lead_email.trim() ? p.lead_email.trim() : (answered.lead ?? null)
  if (lead && leadLabeledNegative(await listLeadReplies(lead))) return 'lead_labeled_negative'
  return null
}
