import 'server-only'
import { listAwaitingActions } from '@/lib/approvals/store'
import { toApprovalItem } from '@/lib/approvals/view'
import { DbError } from '@/lib/db/service'
import { listOpenReplies } from '@/lib/inbox/store'
import { mergeWaiting, type LinkedinWaiting, type RepliesPayload, type ReplyWaiting } from '@/lib/replies/queue'
import { loadLinkedinWaiting } from '@/lib/replydesk/store'
import { createServiceClient } from '@/lib/supabase/service'

const EXCERPT_CHARS = 300

/** Deal ids for (campaign, email) pairs, in one read. */
async function dealIds(emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!emails.length) return out
  const res = await createServiceClient().from('crm_deals').select('id, campaign_id, email').in('email', emails.slice(0, 500)).limit(2000)
  if (res.error) throw new DbError('replies.dealIds', res.error)
  for (const d of (res.data ?? []) as { id: string; campaign_id: string; email: string }[]) out.set(`${d.campaign_id}|${d.email}`, d.id)
  return out
}

/** Unhandled positive replies with their deal and any awaiting draft. Read only. */
export async function loadWaitingReplies(drafts: Map<string, string> = new Map()): Promise<ReplyWaiting[]> {
  const rows = await listOpenReplies()
  const deals = await dealIds([...new Set(rows.map((r) => r.lead_email))])
  return rows.map((r) => ({
    reply_to_uuid: r.reply_to_uuid,
    campaign_id: r.campaign_id,
    lead_email: r.lead_email,
    lead_name: r.lead_name,
    company: r.company,
    subject: r.subject,
    untrusted_excerpt: r.excerpt ? r.excerpt.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS) : null,
    received_at: r.received_at,
    deal_id: r.campaign_id ? (deals.get(`${r.campaign_id}|${r.lead_email}`) ?? null) : null,
    draft_action_id: drafts.get(r.reply_to_uuid) ?? null,
  }))
}

/** /replies: every awaiting pending action plus every unhandled positive reply. Read only; nothing is decided or sent here. */
export async function loadReplies(): Promise<RepliesPayload> {
  const { rows, count } = await listAwaitingActions()
  const drafts = new Map<string, string>()
  for (const r of rows) {
    const id = r.payload?.reply_to_uuid
    if (r.kind === 'send_reply' && typeof id === 'string' && id) drafts.set(id, r.id)
  }
  const [replies, linkedin] = await Promise.all([
    loadWaitingReplies(drafts),
    // The reply desk's tables may be missing on a deployment that has not run its migration yet: show the rest.
    loadLinkedinWaiting().catch((err): LinkedinWaiting[] => {
      console.error('[replies] linkedin failed:', err instanceof Error ? err.message : err)
      return []
    }),
  ])
  return { items: mergeWaiting(rows.map(toApprovalItem), replies, linkedin), approvals: count, replies: replies.length + linkedin.length }
}
