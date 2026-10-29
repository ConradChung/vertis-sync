import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { decryptToken, encryptToken } from '@/lib/slack/crypto'
import type { ChannelBinding } from '@/lib/slack/binding'
import { CARD_FIELDS } from '@/lib/slack/card'

/**
 * lume_slack_installs / _channels / _posts (migration lume_slack_client).
 * Service role only (RLS on, no policies), after the route's guard or the
 * Slack signature check. The bot token is encrypted before it is written and
 * decrypted only to call Slack; listInstalls never selects it.
 */

export interface InstallRow {
  team_id: string
  team_name: string | null
  bot_user_id: string
  scopes: string | null
  installed_by: string | null
  created_at: string
  updated_at: string
  revoked_at: string | null
}

const INSTALL_COLS = 'team_id, team_name, bot_user_id, scopes, installed_by, created_at, updated_at, revoked_at'

/**
 * Store a workspace's install (encrypted token, revoked_at cleared). A
 * REINSTALL onto an existing row (a revoked client reopening an unexpired
 * link, or a re-authorisation) never brings its channels back: every binding
 * of the workspace is paused (active=false) and the owner re-enables them in
 * Settings → Slack. Returns whether the row existed and how many bindings
 * were paused.
 */
export async function saveInstall(i: { team_id: string; team_name: string | null; bot_user_id: string; access_token: string; scope: string | null; installed_by: string | null }): Promise<{ reinstalled: boolean; paused: number }> {
  const sb = createServiceClient()
  const prior = await sb.from('lume_slack_installs').select('team_id').eq('team_id', i.team_id).maybeSingle()
  if (prior.error) throw new DbError('saveInstall', prior.error)
  const reinstalled = !!prior.data
  // Pause first: if the upsert then fails, nothing was re-enabled.
  const paused = reinstalled ? await pauseBindings(i.team_id) : 0
  const res = await sb
    .from('lume_slack_installs')
    .upsert(
      {
        team_id: i.team_id,
        team_name: i.team_name?.slice(0, 200) ?? null,
        bot_user_id: i.bot_user_id,
        bot_token_enc: encryptToken(i.access_token, i.team_id),
        scopes: i.scope?.slice(0, 500) ?? null,
        installed_by: i.installed_by,
        updated_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: 'team_id' }
    )
  if (res.error) throw new DbError('saveInstall', res.error)
  return { reinstalled, paused }
}

/** Pause every active binding of a workspace; returns how many were paused. */
export async function pauseBindings(teamId: string): Promise<number> {
  const res = await createServiceClient()
    .from('lume_slack_channels')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('team_id', teamId)
    .eq('active', true)
    .select('id')
  if (res.error) throw new DbError('pauseBindings', res.error)
  return (res.data ?? []).length
}

export async function listInstalls(): Promise<InstallRow[]> {
  const res = await createServiceClient().from('lume_slack_installs').select(INSTALL_COLS).order('created_at', { ascending: true }).limit(200)
  if (res.error) throw new DbError('listInstalls', res.error)
  return (res.data ?? []) as InstallRow[]
}

export async function getInstall(teamId: string): Promise<InstallRow | null> {
  const res = await createServiceClient().from('lume_slack_installs').select(INSTALL_COLS).eq('team_id', teamId).maybeSingle()
  if (res.error) throw new DbError('getInstall', res.error)
  return (res.data as InstallRow | null) ?? null
}

/** The live workspace's bot token (decrypted), or null when not installed or revoked. */
export async function getBotToken(teamId: string): Promise<{ token: string; bot_user_id: string } | null> {
  const res = await createServiceClient().from('lume_slack_installs').select('bot_token_enc, bot_user_id, revoked_at').eq('team_id', teamId).maybeSingle()
  if (res.error) throw new DbError('getBotToken', res.error)
  const row = res.data as { bot_token_enc: string; bot_user_id: string; revoked_at: string | null } | null
  if (!row || row.revoked_at) return null
  return { token: decryptToken(row.bot_token_enc, teamId), bot_user_id: row.bot_user_id }
}

/**
 * Mark a workspace revoked (uninstall, token revoked, or the owner's Revoke)
 * and pause all its bindings, so even a later reinstall posts nothing until
 * the owner re-enables a channel. True when this call revoked it.
 */
export async function revokeInstall(teamId: string): Promise<boolean> {
  await pauseBindings(teamId)
  const res = await createServiceClient()
    .from('lume_slack_installs')
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('team_id', teamId)
    .is('revoked_at', null)
    .select('team_id')
  if (res.error) throw new DbError('revokeInstall', res.error)
  return (res.data ?? []).length > 0
}

const CHANNEL_COLS = 'id, team_id, channel_id, channel_name, vertical_id, campaign_ids, visible_fields, active'

export async function listBindings(opts: { teamId?: string; activeOnly?: boolean } = {}): Promise<ChannelBinding[]> {
  let q = createServiceClient().from('lume_slack_channels').select(CHANNEL_COLS)
  if (opts.teamId) q = q.eq('team_id', opts.teamId)
  if (opts.activeOnly) q = q.eq('active', true)
  const res = await q.order('created_at', { ascending: true }).limit(500)
  if (res.error) throw new DbError('listBindings', res.error)
  return (res.data ?? []) as ChannelBinding[]
}

export async function getBinding(teamId: string, channelId: string): Promise<ChannelBinding | null> {
  const res = await createServiceClient().from('lume_slack_channels').select(CHANNEL_COLS).eq('team_id', teamId).eq('channel_id', channelId).maybeSingle()
  if (res.error) throw new DbError('getBinding', res.error)
  return (res.data as ChannelBinding | null) ?? null
}

export interface BindingInput {
  team_id: string
  channel_id: string
  channel_name: string | null
  vertical_id: string
  campaign_ids: string[]
  visible_fields: string[]
  active: boolean
}

/** Create or replace the binding of one channel (unique per workspace + channel). */
export async function upsertBinding(b: BindingInput): Promise<ChannelBinding> {
  const res = await createServiceClient()
    .from('lume_slack_channels')
    .upsert(
      {
        ...b,
        channel_name: b.channel_name?.slice(0, 200) ?? null,
        visible_fields: CARD_FIELDS.filter((f) => b.visible_fields.includes(f)),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'team_id,channel_id' }
    )
    .select(CHANNEL_COLS)
    .single()
  if (res.error) throw new DbError('upsertBinding', res.error)
  return res.data as ChannelBinding
}

export async function deleteBinding(id: string): Promise<boolean> {
  const res = await createServiceClient().from('lume_slack_channels').delete().eq('id', id).select('id')
  if (res.error) throw new DbError('deleteBinding', res.error)
  return (res.data ?? []).length > 0
}

export interface PostRow {
  id: number
  reply_to_uuid: string
  team_id: string
  channel_id: string
  ts: string | null
  action_id: string | null
  card: Record<string, Json>
}

const POST_COLS = 'id, reply_to_uuid, team_id, channel_id, ts, action_id, card'

/**
 * Claim the one post of a reply in a channel (the dedupe): the row is
 * inserted before chat.postMessage, so a webhook and a poll racing for the
 * same reply post once. Null when it already exists.
 */
export async function claimPost(p: { reply_to_uuid: string; team_id: string; channel_id: string; card: Record<string, Json>; action_id?: string | null }): Promise<PostRow | null> {
  const res = await createServiceClient()
    .from('lume_slack_posts')
    .upsert({ ...p, action_id: p.action_id ?? null }, { onConflict: 'reply_to_uuid,team_id,channel_id', ignoreDuplicates: true })
    .select(POST_COLS)
  if (res.error) throw new DbError('claimPost', res.error)
  return ((res.data ?? []) as PostRow[])[0] ?? null
}

export async function updatePost(id: number, patch: Partial<Pick<PostRow, 'ts' | 'action_id' | 'card'>>): Promise<void> {
  const res = await createServiceClient().from('lume_slack_posts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
  if (res.error) throw new DbError('updatePost', res.error)
}

/** Drop a claim whose chat.postMessage failed, so a later sighting can post again. */
export async function releasePost(id: number): Promise<void> {
  const res = await createServiceClient().from('lume_slack_posts').delete().eq('id', id).is('ts', null)
  if (res.error) throw new DbError('releasePost', res.error)
}

export async function getPost(id: number): Promise<PostRow | null> {
  const res = await createServiceClient().from('lume_slack_posts').select(POST_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getPost', res.error)
  return (res.data as PostRow | null) ?? null
}

export async function getPostByTs(teamId: string, channelId: string, ts: string): Promise<PostRow | null> {
  const res = await createServiceClient().from('lume_slack_posts').select(POST_COLS).eq('team_id', teamId).eq('channel_id', channelId).eq('ts', ts).maybeSingle()
  if (res.error) throw new DbError('getPostByTs', res.error)
  return (res.data as PostRow | null) ?? null
}

export async function listPostsForReply(replyToUuid: string): Promise<PostRow[]> {
  const res = await createServiceClient().from('lume_slack_posts').select(POST_COLS).eq('reply_to_uuid', replyToUuid).limit(50)
  if (res.error) throw new DbError('listPostsForReply', res.error)
  return (res.data ?? []) as PostRow[]
}
