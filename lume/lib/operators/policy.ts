import type { Json } from '@/lib/db/types'

/**
 * Who may approve an email to a lead. Owner decision (2026-10-29, fixed
 * policy, not a default): a Grok Bot NEVER approves a `send_reply` it drafted
 * itself. "Drafted itself" means `payload.drafted_by_operator` is that bot:
 * a draft filed through the bot API, through POST /api/actions with its
 * cookie, or by Lume's agent in a chat that bot started. Someone else
 * approves: the owner, the master bot (for another bot's draft), later the
 * client (3g). Sending without anyone approving happens only through a
 * campaign's Auto mode (3e). Other kinds are not governed here.
 */

export const SELF_APPROVAL_ERROR = 'a Grok Bot cannot approve a reply it drafted; the owner or another approver must'

export function canApproveSend(
  operator: { id: string; is_master: boolean } | null,
  action: { kind: string; payload: Record<string, Json> | null }
): boolean {
  if (action.kind !== 'send_reply') return true
  if (!operator) return true
  const drafter = action.payload?.drafted_by_operator
  return !(typeof drafter === 'string' && drafter === operator.id)
}
