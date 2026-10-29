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

/** Upsert the mode; returns the previous one. */
export async function setReplyMode(campaignId: string, mode: ReplyMode, by: string): Promise<{ from: ReplyMode; to: ReplyMode }> {
  const from = await getReplyMode(campaignId)
  const res = await createServiceClient()
    .from('lume_campaign_reply_modes')
    .upsert({ campaign_id: campaignId, mode, updated_at: new Date().toISOString(), updated_by: by.slice(0, 120) }, { onConflict: 'campaign_id' })
  if (res.error) throw new DbError('setReplyMode', res.error)
  return { from, to: mode }
}
