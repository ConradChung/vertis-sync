import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { ExportReactor, InfluencerRow } from '@/lib/influencers/model'

/**
 * PM influencer reactions tables (service role, after the owner guard):
 * influencers, influencer_runs, influencer_reactors, influencer_exports.
 * Lume reads these and writes only influencers (add / update) and exports;
 * runs and reactors are written by the `influencer-reactions` edge function.
 */

export const INFLUENCER_COLS =
  'id, name, slug, linkedin_url, lookback_days, max_reactions_per_post, active, notes, last_ran_at, last_posts, last_top_posts, ' +
  'last_reactions, last_reactors, last_leads, last_leads_700, last_apify_usd, last_perplexity_usd, last_haiku_usd, last_cost_usd'

export interface InfluencerRun {
  id: string
  status: 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled' | 'imported'
  stage: string
  influencer_ids: string[]
  start_action_id: string | null
  reactions_action_id: string | null
  max_verify_usd: number | string
  reactions_estimate: { influencer_id: string; slug: string; name: string; posts: number; reactions: number; usd: number }[] | null
  reactions_estimate_usd: number | string | null
  reactions_approved_usd: number | string | null
  counts: Record<string, unknown>
  estimate: Record<string, unknown>
  cost: Record<string, unknown>
  error: string | null
  notes: string | null
  created_at: string
  awaiting_since: string | null
  approved_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
}

const RUN_COLS =
  'id, status, stage, influencer_ids, start_action_id, reactions_action_id, max_verify_usd, reactions_estimate, reactions_estimate_usd, ' +
  'reactions_approved_usd, counts, estimate, cost, error, notes, created_at, awaiting_since, approved_at, finished_at, heartbeat_at'

export async function listInfluencers(opts: { activeOnly?: boolean } = {}): Promise<InfluencerRow[]> {
  const sb = createServiceClient()
  let q = sb.from('influencers').select(INFLUENCER_COLS).order('last_leads', { ascending: false, nullsFirst: false }).order('name')
  if (opts.activeOnly) q = q.eq('active', true)
  const res = await q
  if (res.error) throw new DbError('listInfluencers', res.error)
  return (res.data ?? []) as unknown as InfluencerRow[]
}

export async function getInfluencersBySlugs(slugs: string[]): Promise<InfluencerRow[]> {
  const sb = createServiceClient()
  const res = await sb.from('influencers').select(INFLUENCER_COLS).in('slug', slugs)
  if (res.error) throw new DbError('getInfluencersBySlugs', res.error)
  return (res.data ?? []) as unknown as InfluencerRow[]
}

export async function getInfluencersByIds(ids: string[]): Promise<InfluencerRow[]> {
  const sb = createServiceClient()
  const res = await sb.from('influencers').select(INFLUENCER_COLS).in('id', ids)
  if (res.error) throw new DbError('getInfluencersByIds', res.error)
  return (res.data ?? []) as unknown as InfluencerRow[]
}

export class DuplicateInfluencerError extends Error {
  constructor() {
    super('an influencer with this slug or LinkedIn URL already exists')
    this.name = 'DuplicateInfluencerError'
  }
}

export interface NewInfluencer {
  name: string
  slug: string
  linkedin_url: string
  lookback_days?: number
  max_reactions_per_post?: number
  notes?: string | null
}

export async function insertInfluencer(row: NewInfluencer): Promise<InfluencerRow> {
  const sb = createServiceClient()
  const res = await sb.from('influencers').insert(row).select(INFLUENCER_COLS).single()
  if (res.error?.code === '23505') throw new DuplicateInfluencerError()
  if (res.error || !res.data) throw new DbError('insertInfluencer', res.error ?? new Error('no data'))
  return res.data as unknown as InfluencerRow
}

export interface InfluencerPatch {
  name?: string
  linkedin_url?: string
  lookback_days?: number
  max_reactions_per_post?: number
  active?: boolean
  notes?: string | null
}

/** By slug; null when missing. */
export async function updateInfluencer(slug: string, patch: InfluencerPatch): Promise<InfluencerRow | null> {
  const sb = createServiceClient()
  const res = await sb.from('influencers').update({ ...patch, updated_at: new Date().toISOString() }).eq('slug', slug).select(INFLUENCER_COLS)
  if (res.error?.code === '23505') throw new DuplicateInfluencerError()
  if (res.error) throw new DbError('updateInfluencer', res.error)
  return ((res.data ?? [])[0] as unknown as InfluencerRow | undefined) ?? null
}

export async function getRun(id: string): Promise<InfluencerRun | null> {
  const sb = createServiceClient()
  const res = await sb.from('influencer_runs').select(RUN_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getInfluencerRun', res.error)
  return (res.data as unknown as InfluencerRun | null) ?? null
}

export async function listRuns(limit = 5): Promise<InfluencerRun[]> {
  const sb = createServiceClient()
  const res = await sb.from('influencer_runs').select(RUN_COLS).order('created_at', { ascending: false }).limit(limit)
  if (res.error) throw new DbError('listInfluencerRuns', res.error)
  return (res.data ?? []) as unknown as InfluencerRun[]
}

export async function activeRun(): Promise<InfluencerRun | null> {
  const sb = createServiceClient()
  const res = await sb.from('influencer_runs').select(RUN_COLS).in('status', ['running', 'awaiting_approval']).limit(1)
  if (res.error) throw new DbError('activeInfluencerRun', res.error)
  return ((res.data ?? [])[0] as unknown as InfluencerRun | undefined) ?? null
}

/** This calendar month's Apify spend + reservations on the shared research cap (ledger basis). */
export async function apifyMonthSpend(): Promise<number | null> {
  const sb = createServiceClient()
  const res = await sb.rpc('lume_research_month_spend')
  if (res.error) return null
  return Number(res.data)
}

export interface ExportFilters {
  min_door_count?: number
  only_new?: boolean
  verified_only?: boolean
  run_id?: string
  influencer_slugs?: string[]
  door_count_column?: boolean
  reacted_to_column?: boolean
}

const EXPORT_COLS = 'id, name, linkedin_url, title, company_name, company_website, location, city, state, country, door_count, reacted_to'

/**
 * Reactors for an Apollo export: verified decision makers (or, with
 * verified_only false, also likely / possible candidates not rejected),
 * with at least min_door_count doors, never exported (only_new), from one run
 * or influencers. Most influencers first, then most doors.
 */
export async function exportCandidates(f: ExportFilters, max = 20_000): Promise<ExportReactor[]> {
  const sb = createServiceClient()
  const out: ExportReactor[] = []
  for (let from = 0; from < max; from += 1000) {
    let q = sb.from('influencer_reactors').select(EXPORT_COLS)
    if (f.verified_only === false) q = q.or('verdict.eq.verified,and(verdict.is.null,triage.in.(likely,possible))')
    else q = q.eq('verdict', 'verified')
    if (f.min_door_count !== undefined) q = q.gte('door_count', f.min_door_count)
    if (f.only_new) q = q.is('exported_at', null)
    if (f.run_id) q = q.eq('last_seen_run', f.run_id)
    if (f.influencer_slugs?.length) q = q.overlaps('reacted_to', f.influencer_slugs)
    const res = await q
      .order('influencer_count', { ascending: false })
      .order('door_count', { ascending: false, nullsFirst: false })
      .order('id')
      .range(from, Math.min(from + 999, max - 1))
    if (res.error) throw new DbError('exportCandidates', res.error)
    const page = (res.data ?? []) as unknown as ExportReactor[]
    out.push(...page)
    if (page.length < 1000) break
  }
  return out
}

/** Record the export and mark its reactors exported (so only_new skips them next time). */
export async function createExport(filters: ExportFilters, ids: number[]): Promise<{ id: string; created_at: string }> {
  const sb = createServiceClient()
  const res = await sb.from('influencer_exports').insert({ filters, reactor_ids: ids, row_count: ids.length }).select('id, created_at').single()
  if (res.error || !res.data) throw new DbError('createInfluencerExport', res.error ?? new Error('no data'))
  const now = new Date().toISOString()
  for (let i = 0; i < ids.length; i += 500) {
    const up = await sb.from('influencer_reactors').update({ exported_at: now }).in('id', ids.slice(i, i + 500))
    if (up.error) throw new DbError('markExported', up.error)
  }
  return res.data as { id: string; created_at: string }
}

export async function getExport(id: string): Promise<{ id: string; filters: ExportFilters; reactor_ids: number[]; row_count: number; created_at: string } | null> {
  const sb = createServiceClient()
  const res = await sb.from('influencer_exports').select('id, filters, reactor_ids, row_count, created_at').eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getInfluencerExport', res.error)
  return (res.data as never) ?? null
}

/** The export's reactors, in the export's order. */
export async function exportRows(ids: number[]): Promise<ExportReactor[]> {
  const sb = createServiceClient()
  const byId = new Map<number, ExportReactor>()
  for (let i = 0; i < ids.length; i += 500) {
    const res = await sb.from('influencer_reactors').select(EXPORT_COLS).in('id', ids.slice(i, i + 500))
    if (res.error) throw new DbError('exportRows', res.error)
    for (const r of (res.data ?? []) as unknown as ExportReactor[]) byId.set(Number(r.id), r)
  }
  return ids.map((id) => byId.get(Number(id))).filter((r): r is ExportReactor => !!r)
}

/** slug → display name, for the Reacted To column. */
export async function influencerNames(): Promise<Record<string, string>> {
  const sb = createServiceClient()
  const res = await sb.from('influencers').select('slug, name')
  if (res.error) throw new DbError('influencerNames', res.error)
  return Object.fromEntries(((res.data ?? []) as { slug: string; name: string }[]).map((r) => [r.slug, r.name]))
}

export interface ApifyRunRow { influencer_id: string; kind: 'posts' | 'reactions'; status: string; error: string | null; cost_usd: number | string }

export async function getApifyRuns(runId: string): Promise<ApifyRunRow[]> {
  const sb = createServiceClient()
  const res = await sb.from('influencer_apify_runs').select('influencer_id, kind, status, error, cost_usd').eq('run_id', runId)
  if (res.error) throw new DbError('getInfluencerApifyRuns', res.error)
  return (res.data ?? []) as ApifyRunRow[]
}
