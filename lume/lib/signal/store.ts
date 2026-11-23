import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { parseSignalConfig, SIGNAL_CONFIG_KEY, type SignalConfig } from '@/lib/signal/config'
import type { Block } from '@/lib/slack/card'
import type { SignalDrafts, SignalPersonRow, SignalPostRow } from '@/lib/slack/signalCard'

/**
 * GTM-14 signal tables (migration lume_signal_comments), Lume's side: read
 * what the signal-comments edge fn marked ready, and the claims that make
 * posting to #sales once-only. Service role only, after the cron secret or
 * the Slack signature. Every write that changes alert state is conditional
 * on the state it expects, so a retry, a second tick or a double click finds
 * nothing to do.
 */

export const PERSON_COLS =
  'id, kind, stage, linkedin_url, name, headline, title, company_name, company_website, location, post_id, comment_text, comment_url, commented_at, segment, crawl_verdict, door_count, door_count_source, door_count_confidence, contacts, connected, drafts, alert_status, slack_team_id, slack_channel_id, slack_ts, decided_by, decided_at'

export type SignalPerson = SignalPersonRow & { slack_team_id: string | null; slack_channel_id: string | null; slack_ts: string | null }

export interface SignalNotice {
  key: string
  text: string
}

const POST_COLS = 'post_id, post_url, posted_at, text_excerpt, digest_status'
export type SignalPost = SignalPostRow & { digest_status: string | null }

const nowIso = () => new Date().toISOString()
const sb = () => createServiceClient()

// ── config ───────────────────────────────────────────────────────────────

export async function getSignalConfig(): Promise<SignalConfig> {
  const res = await sb().from('lume_settings').select('value').eq('key', SIGNAL_CONFIG_KEY).maybeSingle()
  if (res.error) throw new DbError('getSignalConfig', res.error)
  return parseSignalConfig(res.data?.value)
}

/** Remember the resolved #sales channel (keeps every other key of the value). */
export async function saveSignalSlack(cfg: SignalConfig, teamId: string, channelId: string): Promise<void> {
  const prev = cfg.raw.slack && typeof cfg.raw.slack === 'object' ? (cfg.raw.slack as Record<string, unknown>) : {}
  const value = { ...cfg.raw, slack: { ...prev, team_id: teamId, channel_id: channelId, channel_name: cfg.slack.channel_name } }
  const res = await sb().from('lume_settings').update({ value, updated_at: nowIso() }).eq('key', SIGNAL_CONFIG_KEY)
  if (res.error) throw new DbError('saveSignalSlack', res.error)
}

// ── commenters ───────────────────────────────────────────────────────────

/** Ready commenters never alerted (alert_status null), oldest first. */
export async function listReadyCommenters(limit = 25): Promise<SignalPerson[]> {
  const res = await sb().from('signal_people').select(PERSON_COLS).eq('stage', 'ready').eq('kind', 'commenter').is('alert_status', null).order('id', { ascending: true }).limit(limit)
  if (res.error) throw new DbError('listReadyCommenters', res.error)
  return (res.data ?? []) as SignalPerson[]
}

export async function getSignalPerson(id: number): Promise<SignalPerson | null> {
  const res = await sb().from('signal_people').select(PERSON_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getSignalPerson', res.error)
  return (res.data as SignalPerson | null) ?? null
}

/** Dry run: keep the card, never post it later. True when this call set it. */
export async function saveDryRunCard(id: number, card: Block[]): Promise<boolean> {
  const res = await sb().from('signal_people').update({ card, alert_status: 'dry_run', updated_at: nowIso() }).eq('id', id).eq('stage', 'ready').is('alert_status', null).select('id')
  if (res.error) throw new DbError('saveDryRunCard', res.error)
  return (res.data ?? []).length > 0
}

/** The once-only claim, taken BEFORE chat.postMessage. False = someone else has it. */
export async function claimPerson(id: number, card: Block[]): Promise<boolean> {
  const res = await sb().from('signal_people').update({ card, alert_status: 'posted', updated_at: nowIso() }).eq('id', id).eq('stage', 'ready').is('alert_status', null).select('id')
  if (res.error) throw new DbError('claimPerson', res.error)
  return (res.data ?? []).length > 0
}

export async function markPersonPosted(id: number, p: { team: string; channel: string; ts: string }): Promise<void> {
  const res = await sb()
    .from('signal_people')
    .update({ slack_team_id: p.team, slack_channel_id: p.channel, slack_ts: p.ts, stage: 'alerted', updated_at: nowIso() })
    .eq('id', id)
    .eq('alert_status', 'posted')
  if (res.error) throw new DbError('markPersonPosted', res.error)
}

/** A failed send gives the claim back (only while nothing was posted). */
export async function releasePerson(id: number): Promise<void> {
  const res = await sb().from('signal_people').update({ alert_status: null, updated_at: nowIso() }).eq('id', id).eq('alert_status', 'posted').is('slack_ts', null)
  if (res.error) throw new DbError('releasePerson', res.error)
}

/**
 * A decision in Slack, conditional on the states it may come from. Returns
 * the updated row, or null when the row had already moved on.
 */
export async function decideSignalPerson(
  id: number,
  from: readonly string[],
  patch: { alert_status: 'approved' | 'edited' | 'skipped'; decided_by: string; drafts?: SignalDrafts }
): Promise<SignalPerson | null> {
  const res = await sb()
    .from('signal_people')
    .update({ ...patch, decided_at: nowIso(), updated_at: nowIso() })
    .eq('id', id)
    .in('alert_status', [...from])
    .select(PERSON_COLS)
  if (res.error) throw new DbError('decideSignalPerson', res.error)
  return ((res.data ?? []) as SignalPerson[])[0] ?? null
}

// ── digests ──────────────────────────────────────────────────────────────

export async function listReadyDigests(limit = 10): Promise<SignalPost[]> {
  const res = await sb().from('signal_posts').select(POST_COLS).eq('digest_status', 'ready').order('posted_at', { ascending: true }).limit(limit)
  if (res.error) throw new DbError('listReadyDigests', res.error)
  return (res.data ?? []) as SignalPost[]
}

export async function getSignalPost(postId: string): Promise<SignalPost | null> {
  const res = await sb().from('signal_posts').select(POST_COLS).eq('post_id', postId).maybeSingle()
  if (res.error) throw new DbError('getSignalPost', res.error)
  return (res.data as SignalPost | null) ?? null
}

/** Ready reactors of one post, never alerted. */
export async function listReadyReactors(postId: string): Promise<SignalPerson[]> {
  const res = await sb().from('signal_people').select(PERSON_COLS).eq('post_id', postId).eq('stage', 'ready').eq('kind', 'reactor').is('alert_status', null).order('door_count', { ascending: false, nullsFirst: false }).limit(200)
  if (res.error) throw new DbError('listReadyReactors', res.error)
  return (res.data ?? []) as SignalPerson[]
}

/** Move a ready digest to `to` (dry_run | posted claim | empty). True when this call did it. */
export async function claimDigest(postId: string, to: 'dry_run' | 'posted' | 'empty', card: Block[] | null): Promise<boolean> {
  const res = await sb().from('signal_posts').update({ digest_status: to, digest_card: card, updated_at: nowIso() }).eq('post_id', postId).eq('digest_status', 'ready').select('post_id')
  if (res.error) throw new DbError('claimDigest', res.error)
  return (res.data ?? []).length > 0
}

export async function markDigestPosted(postId: string, ts: string): Promise<void> {
  const res = await sb().from('signal_posts').update({ digest_slack_ts: ts, digest_posted_at: nowIso(), updated_at: nowIso() }).eq('post_id', postId).eq('digest_status', 'posted')
  if (res.error) throw new DbError('markDigestPosted', res.error)
}

export async function releaseDigest(postId: string): Promise<void> {
  const res = await sb().from('signal_posts').update({ digest_status: 'ready', updated_at: nowIso() }).eq('post_id', postId).eq('digest_status', 'posted').is('digest_slack_ts', null)
  if (res.error) throw new DbError('releaseDigest', res.error)
}

/** Mark the reactors a digest showed. Live: alerted with the post's ts. */
export async function markReactors(ids: number[], status: 'dry_run' | 'posted', slack?: { team: string; channel: string; ts: string }): Promise<void> {
  if (!ids.length) return
  const patch: Record<string, unknown> = { alert_status: status, updated_at: nowIso() }
  if (slack) Object.assign(patch, { stage: 'alerted', slack_team_id: slack.team, slack_channel_id: slack.channel, slack_ts: slack.ts })
  const res = await sb().from('signal_people').update(patch).in('id', ids).eq('kind', 'reactor').is('alert_status', null)
  if (res.error) throw new DbError('markReactors', res.error)
}

// ── notices ──────────────────────────────────────────────────────────────

export async function listPendingNotices(limit = 10): Promise<SignalNotice[]> {
  const res = await sb().from('signal_notices').select('key, text').eq('status', 'pending').order('created_at', { ascending: true }).limit(limit)
  if (res.error) throw new DbError('listPendingNotices', res.error)
  return (res.data ?? []) as SignalNotice[]
}

export async function claimNotice(key: string, to: 'dry_run' | 'posted'): Promise<boolean> {
  const patch: Record<string, unknown> = { status: to }
  if (to === 'posted') patch.posted_at = nowIso()
  const res = await sb().from('signal_notices').update(patch).eq('key', key).eq('status', 'pending').select('key')
  if (res.error) throw new DbError('claimNotice', res.error)
  return (res.data ?? []).length > 0
}

export async function releaseNotice(key: string): Promise<void> {
  const res = await sb().from('signal_notices').update({ status: 'pending', posted_at: null }).eq('key', key).eq('status', 'posted')
  if (res.error) throw new DbError('releaseNotice', res.error)
}
