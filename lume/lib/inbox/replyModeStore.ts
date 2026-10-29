import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { parseReplyMode, type ReplyMode } from '@/lib/inbox/replyMode'

/**
 * `lume_campaign_reply_modes` (migration lume_reply_modes_webhooks), keyed by
 * the Instantly campaign id. A campaign with no row is `owner`. Service role,
 * after the route's guard; only the owner's own session may change a mode
 * (app/api/campaigns/reply-mode/route.ts).
 */

export interface ReplyModeRow {
  campaign_id: string
  mode: ReplyMode
  updated_at: string
  updated_by: string | null
}

export async function getReplyMode(campaignId: string): Promise<ReplyMode> {
  const res = await createServiceClient().from('lume_campaign_reply_modes').select('mode').eq('campaign_id', campaignId).maybeSingle()
  if (res.error) throw new DbError('getReplyMode', res.error)
  return parseReplyMode((res.data as { mode?: string } | null)?.mode)
}

export async function listReplyModes(): Promise<ReplyModeRow[]> {
  const res = await createServiceClient().from('lume_campaign_reply_modes').select('campaign_id, mode, updated_at, updated_by').order('campaign_id').limit(1000)
  if (res.error) throw new DbError('listReplyModes', res.error)
  return (res.data ?? []) as ReplyModeRow[]
}

/**
 * Set the mode and, when it changed, write its `lume.reply_mode_changed`
 * event in the same transaction (RPC `lume_set_reply_mode`, migration
 * 20261029032934): a change is never stored without its audit row.
 */
export async function setReplyMode(campaignId: string, mode: ReplyMode, by: string): Promise<{ from: ReplyMode; to: ReplyMode; event_id: number | null }> {
  const res = await createServiceClient().rpc('lume_set_reply_mode', { p_campaign_id: campaignId, p_mode: mode, p_by: by.slice(0, 120) })
  if (res.error) throw new DbError('setReplyMode', res.error)
  const d = (res.data ?? {}) as { from?: string; to?: string; event_id?: number | null }
  return { from: parseReplyMode(d.from), to: parseReplyMode(d.to), event_id: d.event_id ?? null }
}
