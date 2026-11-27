import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { CONTENT_CONFIG_KEY, parseContentConfig, round4, type ContentConfig } from '@/lib/content/config'
import type { ContentStore, DraftRow } from '@/lib/content/engine'
import { isFactKind, type Fact, type LeadUse } from '@/lib/content/facts'
import type { MatchDraft, MatchPost } from '@/lib/content/match'
import type { Slot, Variant } from '@/lib/content/slots'

/** Supabase side of the draft generator (service role; tables are RLS-locked). */

const sb = () => createServiceClient()
const nowIso = () => new Date().toISOString()

export async function getContentConfig(): Promise<ContentConfig> {
  const res = await sb().from('lume_settings').select('value').eq('key', CONTENT_CONFIG_KEY).maybeSingle()
  if (res.error) throw new DbError('getContentConfig', res.error)
  return parseContentConfig(res.data?.value)
}

/** Remember the resolved channel (keeps every other key of the value). */
export async function saveContentSlack(cfg: ContentConfig, teamId: string, channelId: string): Promise<void> {
  const prev = cfg.raw.slack && typeof cfg.raw.slack === 'object' ? (cfg.raw.slack as Record<string, unknown>) : {}
  const value = { ...cfg.raw, slack: { ...prev, team_id: teamId, channel_id: channelId, channel_name: cfg.slack.channel_name } }
  const res = await sb().from('lume_settings').update({ value, updated_at: nowIso() }).eq('key', CONTENT_CONFIG_KEY)
  if (res.error) throw new DbError('saveContentSlack', res.error)
}

export interface ContentDraft {
  id: number
  slot: Slot
  variant: Variant | null
  status: string
  formula: string | null
  body: string | null
  first_comment: string | null
  char_count: number | null
  fact_ids: number[]
  slack_team_id: string | null
  slack_channel_id: string | null
  slack_ts: string | null
  decided_by: string | null
}

const DRAFT_COLS = 'id, slot, variant, status, formula, body, first_comment, char_count, fact_ids, slack_team_id, slack_channel_id, slack_ts, decided_by'

export async function getDraft(id: number): Promise<ContentDraft | null> {
  const res = await sb().from('content_drafts').select(DRAFT_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getDraft', res.error)
  return (res.data as ContentDraft | null) ?? null
}

/** Conditional on 'accepted', so a double click decides once. Returns the updated row or null. */
export async function decideDraft(id: number, status: 'skipped' | 'superseded', user: string): Promise<ContentDraft | null> {
  const t = nowIso()
  const res = await sb()
    .from('content_drafts')
    .update({ status, decided_by: user, decided_at: t, updated_at: t })
    .eq('id', id)
    .eq('status', 'accepted')
    .select(DRAFT_COLS)
  if (res.error) throw new DbError('decideDraft', res.error)
  return ((res.data ?? [])[0] as ContentDraft | undefined) ?? null
}

export const liveStore: ContentStore = {
  getConfig: getContentConfig,

  async activeFacts(): Promise<Fact[]> {
    const res = await sb().from('content_facts').select('id, kind, text, source, active').eq('active', true).order('id')
    if (res.error) throw new DbError('activeFacts', res.error)
    return ((res.data ?? []) as Fact[]).filter((f) => isFactKind(f.kind))
  },

  async leadUses(sinceIso: string): Promise<LeadUse[]> {
    const res = await sb().from('content_drafts').select('lead_fact_id, created_at, status').gte('created_at', sinceIso).limit(1000)
    if (res.error) throw new DbError('leadUses', res.error)
    return (res.data ?? []) as LeadUse[]
  },

  async monthSpend(fromIso: string): Promise<number> {
    const res = await sb().from('content_spend').select('usd').gte('created_at', fromIso).limit(10_000)
    if (res.error) throw new DbError('monthSpend', res.error)
    return round4((res.data ?? []).reduce((s, r) => s + Number((r as { usd: number | string }).usd || 0), 0))
  },

  async addSpend(row): Promise<number> {
    const res = await sb().from('content_spend').insert(row).select('id').single()
    if (res.error) throw new DbError('addSpend', res.error)
    return (res.data as { id: number }).id
  },

  async linkSpend(spendIds: number[], draftId: number): Promise<void> {
    const res = await sb().from('content_spend').update({ draft_id: draftId }).in('id', spendIds)
    if (res.error) throw new DbError('linkSpend', res.error)
  },

  async hasCronDraft(runDate: string): Promise<boolean> {
    const res = await sb().from('content_drafts').select('id').eq('run_date', runDate).eq('trigger', 'cron').limit(1)
    if (res.error) throw new DbError('hasCronDraft', res.error)
    return (res.data ?? []).length > 0
  },

  async insertDraft(row: DraftRow): Promise<number> {
    const res = await sb().from('content_drafts').insert(row).select('id').single()
    if (res.error) throw new DbError('insertDraft', res.error)
    return (res.data as { id: number }).id
  },

  async setDraftSlack(id: number, team: string, channel: string, ts: string): Promise<void> {
    const res = await sb().from('content_drafts').update({ slack_team_id: team, slack_channel_id: channel, slack_ts: ts, updated_at: nowIso() }).eq('id', id)
    if (res.error) throw new DbError('setDraftSlack', res.error)
  },

  async recentPosts(sinceIso: string): Promise<MatchPost[]> {
    const res = await sb().from('signal_posts').select('post_id, text_excerpt, posted_at').gte('posted_at', sinceIso).limit(500)
    if (res.error) throw new DbError('recentPosts', res.error)
    return (res.data ?? []) as MatchPost[]
  },

  async unmatchedDrafts(sinceIso: string): Promise<MatchDraft[]> {
    const res = await sb()
      .from('content_drafts')
      .select('id, body, created_at')
      .in('status', ['accepted', 'skipped', 'superseded'])
      .is('posted_post_id', null)
      .not('body', 'is', null)
      .gte('created_at', sinceIso)
      .limit(500)
    if (res.error) throw new DbError('unmatchedDrafts', res.error)
    return (res.data ?? []) as MatchDraft[]
  },

  async markPosted(draftId: number, postId: string, postedAt: string): Promise<boolean> {
    const t = nowIso()
    const res = await sb()
      .from('content_drafts')
      .update({ status: 'posted', posted_post_id: postId, posted_at: postedAt, updated_at: t })
      .eq('id', draftId)
      .is('posted_post_id', null)
      .select('id')
    if (res.error) {
      // 23505: the post is already tied to another draft.
      if (res.error.code === '23505') return false
      throw new DbError('markPosted', res.error)
    }
    return (res.data ?? []).length > 0
  },
}
