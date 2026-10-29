import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'

/**
 * `lume_replies` (migration lume_inbox_replies): positive inbound replies,
 * one row per Instantly email id. Written when the webhook or the
 * list_replies poll first sees one; `handled_at` is set when a reply is sent
 * (send_reply executed) or a label means none is owed. Service role, after
 * the route's owner guard.
 */

export interface ReplyRow {
  reply_to_uuid: string
  campaign_id: string | null
  lead_email: string
  lead_name: string | null
  company: string | null
  eaccount: string | null
  subject: string | null
  thread_id: string | null
  excerpt: string | null
  interest: number | null
  source: 'webhook' | 'poll'
  received_at: string
  created_at: string
  handled_at: string | null
  handled_how: string | null
  handled_action_id: string | null
}

export type ReplyInsert = Pick<ReplyRow, 'reply_to_uuid' | 'lead_email' | 'source'> &
  Partial<Pick<ReplyRow, 'campaign_id' | 'lead_name' | 'company' | 'eaccount' | 'subject' | 'thread_id' | 'excerpt' | 'interest' | 'received_at'>>

const COLS =
  'reply_to_uuid, campaign_id, lead_email, lead_name, company, eaccount, subject, thread_id, excerpt, interest, source, received_at, created_at, handled_at, handled_how, handled_action_id'

const clip = (v: string | null | undefined, n: number) => (v == null ? null : v.length > n ? v.slice(0, n) : v)

/** Record a positive reply; true when this call created the row (first sighting). */
export async function recordReply(row: ReplyInsert): Promise<boolean> {
  const res = await createServiceClient()
    .from('lume_replies')
    .upsert(
      {
        ...row,
        lead_email: row.lead_email.toLowerCase(),
        lead_name: clip(row.lead_name, 300),
        company: clip(row.company, 300),
        subject: clip(row.subject, 500),
        excerpt: clip(row.excerpt, 2000),
      },
      { onConflict: 'reply_to_uuid', ignoreDuplicates: true }
    )
    .select('reply_to_uuid')
  if (res.error) throw new DbError('recordReply', res.error)
  return (res.data ?? []).length > 0
}

/** Unhandled positive replies, newest first. */
export async function listOpenReplies(limit = 200): Promise<ReplyRow[]> {
  const res = await createServiceClient()
    .from('lume_replies')
    .select(COLS)
    .is('handled_at', null)
    .order('received_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500))
  if (res.error) throw new DbError('listOpenReplies', res.error)
  return (res.data ?? []) as ReplyRow[]
}

/** Mark one reply handled (first mark wins). True when this call marked it. */
export async function markReplyHandled(replyToUuid: string, how: string, actionId: string | null = null): Promise<boolean> {
  const res = await createServiceClient()
    .from('lume_replies')
    .update({ handled_at: new Date().toISOString(), handled_how: how.slice(0, 80), handled_action_id: actionId })
    .eq('reply_to_uuid', replyToUuid)
    .is('handled_at', null)
    .select('reply_to_uuid')
  if (res.error) throw new DbError('markReplyHandled', res.error)
  return (res.data ?? []).length > 0
}

/** Mark every open reply of a lead in a campaign handled; returns the reply ids marked. */
export async function markLeadRepliesHandled(campaignId: string, email: string, how: string): Promise<string[]> {
  const res = await createServiceClient()
    .from('lume_replies')
    .update({ handled_at: new Date().toISOString(), handled_how: how.slice(0, 80) })
    .eq('campaign_id', campaignId)
    .eq('lead_email', email.toLowerCase())
    .is('handled_at', null)
    .select('reply_to_uuid')
  if (res.error) throw new DbError('markLeadRepliesHandled', res.error)
  return ((res.data ?? []) as { reply_to_uuid: string }[]).map((r) => r.reply_to_uuid)
}
