import type { Json } from '@/lib/db/types'

/**
 * May this Slack user Approve, Edit or Skip this reply from this channel
 * (3g)? Pure; the route gathers the facts fresh at click time and
 * lib/slack/decide.ts calls this before any claim. Null = allowed.
 *
 *  - only a send_reply that is still awaiting;
 *  - only from a channel bound to the reply's campaign (live install, active
 *    binding, the vertical still owns the campaign);
 *  - only while the campaign is in Client mode (Owner mode: the owner
 *    approves; Auto mode: the grant does);
 *  - never on a possible opt-out / hostile reply;
 *  - a client's Edit is drafting: the user whose edit is the current body may
 *    not approve it (`edited_by_slack_user`); someone else must.
 */

export type ClientDecision = 'approve' | 'edit' | 'skip'

export type ClientRefusal = 'not_send_reply' | 'already_decided' | 'not_bound' | 'not_client_mode' | 'opt_out' | 'self_edit'

export interface ClientDecisionInput {
  decision: ClientDecision
  slackUser: string
  action: { kind: string; status: string; payload: Record<string, Json> | null; edited_by_slack_user?: string | null }
  covered: boolean
  mode: 'owner' | 'client' | 'auto'
  optOut: boolean
}

export function clientDecisionError(c: ClientDecisionInput): ClientRefusal | null {
  if (c.action.kind !== 'send_reply') return 'not_send_reply'
  if (c.action.status !== 'awaiting') return 'already_decided'
  if (!c.covered) return 'not_bound'
  if (c.mode !== 'client') return 'not_client_mode'
  if (c.optOut && c.decision !== 'skip') return 'opt_out'
  if (c.decision === 'approve' && c.action.edited_by_slack_user && c.action.edited_by_slack_user === c.slackUser) return 'self_edit'
  return null
}

/** What the clicking user is told (ephemeral). */
export const CLIENT_REFUSAL_TEXT: Record<ClientRefusal, string> = {
  not_send_reply: 'This item cannot be decided from Slack.',
  already_decided: 'This reply was already decided.',
  not_bound: 'This channel is no longer connected to that campaign.',
  not_client_mode: 'This campaign is not in Client approval mode any more; Conrad approves its replies.',
  opt_out: 'This may be an opt-out or a hostile reply, so it cannot be approved here. Conrad handles it.',
  self_edit: 'You edited this reply, so someone else must approve it (Conrad or another teammate).',
}
