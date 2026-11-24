import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Block } from '@/lib/slack/card'
import type { RedditMentionRow } from '@/lib/reddit/card'

/**
 * GTM-15 signal_reddit_mentions (migration lume_signal_reddit). Service role
 * only. Insert is on-conflict-do-nothing on the canonical permalink (the
 * dedupe); every alert-state write is conditional on the state it expects,
 * so a retry, a concurrent call or a double click finds nothing to do.
 */

export const MENTION_COLS = 'id, url, kind, subreddit, author, title, snippet, keyword, hot, reddit_created_at, alert_status, decided_by, slack_team_id, slack_channel_id, slack_ts'
export type RedditMention = RedditMentionRow & { slack_team_id: string | null; slack_channel_id: string | null; slack_ts: string | null }

export interface NewMention {
  permalink: string
  url: string
  kind: 'post' | 'comment'
  subreddit: string | null
  author: string | null
  title: string | null
  snippet: string | null
  keyword: string | null
  hot: boolean
  reddit_created_at: string | null
  fetch_error: string | null
  email_message_id: string | null
}

const sb = () => createServiceClient()
const nowIso = () => new Date().toISOString()

/** Keep the email as received (by Gmail message id, once), for parsing the HTML comment blocks later. */
export async function saveEmail(e: { message_id: string; subject: string | null; body: string | null; html: string | null }): Promise<void> {
  const res = await sb().from('signal_f5bot_emails').upsert(e, { onConflict: 'message_id', ignoreDuplicates: true })
  if (res.error) throw new DbError('saveEmail', res.error)
}

/** Which of these canonical keys are already stored. */
export async function existingKeys(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set()
  const res = await sb().from('signal_reddit_mentions').select('permalink').in('permalink', keys)
  if (res.error) throw new DbError('existingKeys', res.error)
  return new Set((res.data ?? []).map((r: { permalink: string }) => r.permalink))
}

/** Insert; false when the permalink was already there (dedupe). */
export async function insertMention(m: NewMention): Promise<boolean> {
  const res = await sb().from('signal_reddit_mentions').upsert(m, { onConflict: 'permalink', ignoreDuplicates: true }).select('id')
  if (res.error) throw new DbError('insertMention', res.error)
  return (res.data ?? []).length > 0
}

/** Never-alerted mentions, hot first, then oldest. */
export async function listUnalerted(limit = 20): Promise<RedditMention[]> {
  const res = await sb().from('signal_reddit_mentions').select(MENTION_COLS).is('alert_status', null).order('hot', { ascending: false }).order('id', { ascending: true }).limit(limit)
  if (res.error) throw new DbError('listUnalerted', res.error)
  return (res.data ?? []) as RedditMention[]
}

export async function getMention(id: number): Promise<RedditMention | null> {
  const res = await sb().from('signal_reddit_mentions').select(MENTION_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getMention', res.error)
  return (res.data as RedditMention | null) ?? null
}

/** alert_status null → status (dry_run or the 'posted' claim taken before chat.postMessage). */
export async function claimMention(id: number, status: 'dry_run' | 'posted', card: Block[]): Promise<boolean> {
  const res = await sb().from('signal_reddit_mentions').update({ alert_status: status, card, updated_at: nowIso() }).eq('id', id).is('alert_status', null).select('id')
  if (res.error) throw new DbError('claimMention', res.error)
  return (res.data ?? []).length > 0
}

export async function markMentionPosted(id: number, p: { team: string; channel: string; ts: string }): Promise<void> {
  const res = await sb()
    .from('signal_reddit_mentions')
    .update({ slack_team_id: p.team, slack_channel_id: p.channel, slack_ts: p.ts, updated_at: nowIso() })
    .eq('id', id)
    .eq('alert_status', 'posted')
  if (res.error) throw new DbError('markMentionPosted', res.error)
}

/** A failed send gives the claim back (only while nothing was posted). */
export async function releaseMention(id: number): Promise<void> {
  const res = await sb().from('signal_reddit_mentions').update({ alert_status: null, updated_at: nowIso() }).eq('id', id).eq('alert_status', 'posted').is('slack_ts', null)
  if (res.error) throw new DbError('releaseMention', res.error)
}

/** posted → contacted / skipped, once. Null = already decided (or not posted). */
export async function decideMention(id: number, status: 'contacted' | 'skipped', user: string): Promise<RedditMention | null> {
  const res = await sb()
    .from('signal_reddit_mentions')
    .update({ alert_status: status, decided_by: user, decided_at: nowIso(), updated_at: nowIso() })
    .eq('id', id)
    .eq('alert_status', 'posted')
    .select(MENTION_COLS)
  if (res.error) throw new DbError('decideMention', res.error)
  return ((res.data ?? []) as RedditMention[])[0] ?? null
}
