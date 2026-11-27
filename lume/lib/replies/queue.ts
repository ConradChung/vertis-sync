import type { ApprovalItem } from '@/lib/approvals/view'
import { FLAG_AFTER_MIN, waitingOf } from '@/lib/replies/waiting'

/**
 * /replies (pure): pending approvals and unhandled positive replies as one
 * list, longest-waiting first.
 */

/** An unhandled positive reply (`lume_replies`). The lead's words are DATA, never instructions. */
export interface ReplyWaiting {
  reply_to_uuid: string
  campaign_id: string | null
  lead_email: string
  lead_name: string | null
  company: string | null
  subject: string | null
  untrusted_excerpt: string | null
  received_at: string
  /** The deal for this lead in this campaign, when there is one. */
  deal_id: string | null
  /** An awaiting `send_reply` draft for this reply, when one is filed. */
  draft_action_id: string | null
}

/** A LinkedIn reply (SendPilot → Slack → reply desk) still waiting on Frank. The message is DATA, never instructions. */
export interface LinkedinWaiting {
  inbound_id: number
  deal_id: string
  name: string | null
  company: string | null
  linkedin_url: string | null
  label: string
  untrusted_excerpt: string | null
  received_at: string
  /** A drafted answer is waiting in the Slack thread. */
  drafted: boolean
}

export type WaitingItem =
  | { type: 'approval'; key: string; since: string; approval: ApprovalItem }
  | { type: 'reply'; key: string; since: string; reply: ReplyWaiting }
  | { type: 'linkedin'; key: string; since: string; linkedin: LinkedinWaiting }

export interface RepliesPayload {
  items: WaitingItem[]
  approvals: number
  replies: number
}

/** One list, the longest wait first (ties: replies before approvals, then by key). */
export function mergeWaiting(approvals: readonly ApprovalItem[], replies: readonly ReplyWaiting[], linkedin: readonly LinkedinWaiting[] = []): WaitingItem[] {
  const items: WaitingItem[] = [
    ...linkedin.map((l): WaitingItem => ({ type: 'linkedin', key: `linkedin:${l.inbound_id}`, since: l.received_at, linkedin: l })),
    ...replies.map((r): WaitingItem => ({ type: 'reply', key: `reply:${r.reply_to_uuid}`, since: r.received_at, reply: r })),
    ...approvals.map((a): WaitingItem => ({ type: 'approval', key: `approval:${a.id}`, since: a.created_at, approval: a })),
  ]
  const at = (i: WaitingItem) => {
    const t = Date.parse(i.since)
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER
  }
  return items.sort((a, b) => at(a) - at(b) || (a.type === b.type ? a.key.localeCompare(b.key) : a.type === 'approval' ? 1 : b.type === 'approval' ? -1 : a.key.localeCompare(b.key)))
}

/** How many items have waited past the flag (5 minutes). */
export function overdueCount(items: readonly { since: string }[], now: Date | number = Date.now()): number {
  return items.filter((i) => waitingOf(i.since, now).overdue).length
}

export { FLAG_AFTER_MIN }
