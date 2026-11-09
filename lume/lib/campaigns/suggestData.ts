import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError, CAMPAIGN_CHOICE_STATUSES } from '@/lib/db/service'
import { isInstantlyConfigured, listAccounts, listCampaignSetups } from '@/lib/adapters/instantly'
import type { InstantlyAccount } from '@/lib/adapters/instantly.map'
import { jobName } from '@/lib/validate/jobs'
import {
  profileLeads,
  publicProfile,
  scoreVerticals,
  sequencePreview,
  suggestCampaign,
  type CampaignSetup,
  type HistoryProfile,
  type LeadProfile,
  type LeadRow,
  type RankedTemplate,
  type SequencePreview,
  type Suggestion,
  type TemplateInput,
  type VerticalScore,
} from '@/lib/campaigns/suggest'

/**
 * Server side of New campaign suggestions: reads a lead sample, the tags, the
 * templates, past jobs and Instantly's campaigns (all read-only), then hands
 * them to the pure suggester (lib/campaigns/suggest.ts).
 * GET /api/campaigns/suggest and the agent's suggest_campaign_setup use this.
 */

const SAMPLE = 500
const HISTORY_JOBS = 5
const HISTORY_SAMPLE = 100

export type SuggestSource = { job_id: string } | { list_id: string } | null

export interface VerticalRow {
  id: string
  name: string
  campaign_ids: string[]
  keywords: string[]
}

export interface TemplateRow extends TemplateInput {
  description: string | null
}

export interface SourceInfo {
  kind: 'job' | 'list'
  id: string
  label: string
  vertical_id: string | null
  rows: number
  /** Job only: still waiting for a campaign pick (a created campaign would be picked for it). */
  awaiting_campaign?: boolean
}

export interface SuggestResponse {
  source: SourceInfo | null
  profile: Omit<LeadProfile, 'text'> | null
  verticals: VerticalScore[]
  suggestion: Suggestion
  options: {
    verticals: { id: string; name: string }[]
    templates: (RankedTemplate & { description: string | null; preview: SequencePreview | null })[]
    accounts: Pick<InstantlyAccount, 'email' | 'status' | 'warmup_score'>[]
    sources: { jobs: SourceOption[]; lists: SourceOption[] }
  }
  instantly: { configured: boolean; error?: string }
}

export interface SourceOption {
  id: string
  label: string
  rows: number
  created_at: string
  vertical_id: string | null
}

const sb = () => createServiceClient()

export async function loadVerticals(): Promise<VerticalRow[]> {
  const res = await sb().from('lume_verticals').select('id,name,campaign_ids,keywords').is('archived_at', null).order('name')
  if (res.error) throw new DbError('loadVerticals', res.error)
  return ((res.data ?? []) as Partial<VerticalRow>[]).map((v) => ({
    id: String(v.id),
    name: String(v.name),
    campaign_ids: Array.isArray(v.campaign_ids) ? v.campaign_ids : [],
    keywords: Array.isArray(v.keywords) ? v.keywords : [],
  }))
}

export async function loadTemplates(): Promise<TemplateRow[]> {
  const res = await sb().from('campaign_templates').select('id,name,description,vertical_id,sequences').order('name')
  if (res.error) throw new DbError('loadTemplates', res.error)
  return (res.data ?? []) as TemplateRow[]
}

type JobHead = { id: string; filename: string | null; display_name: string | null; vertical_id: string | null; instantly_status: string | null; total_rows: number | null; created_at: string }

async function jobRows(jobId: string, limit: number): Promise<LeadRow[]> {
  const valid = await sb().from('validation_rows').select('row_data').eq('job_id', jobId).eq('status', 'valid').limit(limit)
  if (valid.error) throw new DbError('jobRows', valid.error)
  let rows = (valid.data ?? []) as { row_data: LeadRow | null }[]
  if (!rows.length) {
    // Still validating (or nothing valid): profile what is there.
    const any = await sb().from('validation_rows').select('row_data').eq('job_id', jobId).limit(limit)
    if (any.error) throw new DbError('jobRows.any', any.error)
    rows = (any.data ?? []) as { row_data: LeadRow | null }[]
  }
  return rows.map((r) => r.row_data ?? {})
}

/** A lead list / review set's kept rows: its own cells, plus the mapped fields under plain names. */
async function listRows(setId: string, limit: number): Promise<LeadRow[]> {
  const res = await sb().from('lead_review_items').select('item,cells').eq('set_id', setId).eq('status', 'kept').order('idx').limit(limit)
  if (res.error) throw new DbError('listRows', res.error)
  return ((res.data ?? []) as { item: Record<string, unknown> | null; cells: Record<string, unknown> | null }[]).map(({ item, cells }) => {
    const row: LeadRow = { ...(cells ?? {}) }
    const put = (k: string, v: unknown) => {
      if (v !== null && v !== undefined && v !== '' && row[k] === undefined) row[k] = v
    }
    put('title', item?.title)
    put('company', item?.company)
    put('industry', item?.category)
    put('city', item?.city)
    put('state', item?.state)
    put('country', item?.country)
    return row
  })
}

export async function loadSource(src: SuggestSource): Promise<{ info: SourceInfo; rows: LeadRow[] } | null> {
  if (!src) return null
  if ('job_id' in src) {
    const res = await sb()
      .from('validation_jobs')
      .select('id,filename,display_name,vertical_id,instantly_status,total_rows,created_at')
      .eq('id', src.job_id)
      .maybeSingle()
    if (res.error) throw new DbError('loadSource.job', res.error)
    const j = res.data as JobHead | null
    if (!j) return null
    const rows = await jobRows(j.id, SAMPLE)
    return {
      info: {
        kind: 'job',
        id: j.id,
        label: jobName({ total_rows: j.total_rows ?? 0, created_at: j.created_at, display_name: j.display_name ?? j.filename }),
        vertical_id: j.vertical_id,
        rows: j.total_rows ?? rows.length,
        awaiting_campaign: (CAMPAIGN_CHOICE_STATUSES as readonly string[]).includes(j.instantly_status ?? ''),
      },
      rows,
    }
  }
  const res = await sb().from('lead_review_sets').select('id,title,vertical_id,item_count').eq('id', src.list_id).is('archived_at', null).maybeSingle()
  if (res.error) throw new DbError('loadSource.list', res.error)
  const s = res.data as { id: string; title: string | null; vertical_id: string | null; item_count: number | null } | null
  if (!s) return null
  const rows = await listRows(s.id, SAMPLE)
  return { info: { kind: 'list', id: s.id, label: s.title || 'Lead list', vertical_id: s.vertical_id, rows: s.item_count ?? rows.length }, rows }
}

/**
 * Which tag each past campaign belongs to (its `campaign_ids`, or the tag of
 * a job pushed to it), and profiles of the most recent tagged jobs.
 */
async function loadHistory(verticals: VerticalRow[], excludeJobId: string | null, withProfiles: boolean) {
  const res = await sb()
    .from('validation_jobs')
    .select('id,vertical_id,instantly_campaign_id,created_at')
    .not('instantly_campaign_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50)
  if (res.error) throw new DbError('loadHistory', res.error)
  const byCampaign = new Map<string, string>()
  for (const v of verticals) for (const c of v.campaign_ids) byCampaign.set(c, v.id)
  const campaigns = new Map<string, Set<string>>(verticals.map((v) => [v.id, new Set(v.campaign_ids)]))
  const tagged: { id: string; vertical_id: string }[] = []
  for (const j of (res.data ?? []) as { id: string; vertical_id: string | null; instantly_campaign_id: string }[]) {
    const vid = j.vertical_id ?? byCampaign.get(j.instantly_campaign_id) ?? null
    if (!vid || !campaigns.has(vid)) continue
    campaigns.get(vid)!.add(j.instantly_campaign_id)
    if (j.id !== excludeJobId) tagged.push({ id: j.id, vertical_id: vid })
  }
  let history: HistoryProfile[] = []
  if (withProfiles) {
    const picked = tagged.slice(0, HISTORY_JOBS)
    history = (
      await Promise.all(
        picked.map(async (j): Promise<HistoryProfile | null> => {
          try {
            const rows = await jobRows(j.id, HISTORY_SAMPLE)
            return rows.length ? { vertical_id: j.vertical_id, profile: profileLeads(rows) } : null
          } catch (err) {
            console.error('[campaigns/suggest] history sample failed:', err instanceof Error ? err.message : err)
            return null
          }
        })
      )
    ).filter((h): h is HistoryProfile => h !== null)
  }
  return { campaigns: campaigns as Map<string, ReadonlySet<string>>, history }
}

async function loadSources(): Promise<SuggestResponse['options']['sources']> {
  const [jobs, lists] = await Promise.all([
    sb()
      .from('validation_jobs')
      .select('id,filename,display_name,vertical_id,instantly_status,total_rows,created_at')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(15),
    sb()
      .from('lead_review_sets')
      .select('id,title,vertical_id,item_count,created_at')
      .eq('kind', 'list')
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(15),
  ])
  if (jobs.error) throw new DbError('loadSources.jobs', jobs.error)
  if (lists.error) throw new DbError('loadSources.lists', lists.error)
  return {
    jobs: ((jobs.data ?? []) as JobHead[])
      .filter((j) => (j.total_rows ?? 0) > 0)
      .map((j) => ({
        id: j.id,
        label: jobName({ total_rows: j.total_rows ?? 0, created_at: j.created_at, display_name: j.display_name ?? j.filename }),
        rows: j.total_rows ?? 0,
        created_at: j.created_at,
        vertical_id: j.vertical_id,
      })),
    lists: ((lists.data ?? []) as { id: string; title: string | null; vertical_id: string | null; item_count: number | null; created_at: string }[]).map((l) => ({
      id: l.id,
      label: l.title || 'Lead list',
      rows: l.item_count ?? 0,
      created_at: l.created_at,
      vertical_id: l.vertical_id,
    })),
  }
}

async function loadInstantly(): Promise<{ campaigns: CampaignSetup[]; accounts: InstantlyAccount[]; configured: boolean; error?: string }> {
  if (!isInstantlyConfigured()) return { campaigns: [], accounts: [], configured: false }
  try {
    const [campaigns, accounts] = await Promise.all([listCampaignSetups(), listAccounts()])
    return { campaigns, accounts, configured: true }
  } catch (err) {
    console.error('[campaigns/suggest] Instantly read failed:', err instanceof Error ? err.message : err)
    return { campaigns: [], accounts: [], configured: true, error: 'instantly_unavailable' }
  }
}

/** Everything the New campaign sheet needs, with suggestions when a lead source is given. */
export async function getCampaignSuggestion(src: SuggestSource, opts: { now?: Date; withSources?: boolean } = {}): Promise<SuggestResponse | null> {
  const [verticals, templates, source, instantly, sources] = await Promise.all([
    loadVerticals(),
    loadTemplates(),
    loadSource(src),
    loadInstantly(),
    opts.withSources === false ? Promise.resolve({ jobs: [], lists: [] }) : loadSources(),
  ])
  if (src && !source) return null
  const { campaigns: verticalCampaigns, history } = await loadHistory(verticals, source?.info.kind === 'job' ? source.info.id : null, !!source)
  const profile = source ? profileLeads(source.rows) : null
  const ranked = profile
    ? scoreVerticals(profile, verticals, { taggedVerticalId: source?.info.vertical_id ?? null, history })
    : verticals.map((v): VerticalScore => ({ id: v.id, name: v.name, score: 0, coverage: 0, history: 0, source: 'none', why: '' }))
  const { templates: rankedTemplates, ...suggestion } = suggestCampaign({
    profile,
    ranked: profile ? ranked : [],
    templates,
    campaigns: instantly.campaigns,
    verticalCampaigns,
    now: opts.now ?? new Date(),
  })
  const byId = new Map(templates.map((t) => [t.id, t]))
  return {
    source: source?.info ?? null,
    profile: profile ? publicProfile(profile) : null,
    verticals: ranked,
    suggestion,
    options: {
      verticals: verticals.map((v) => ({ id: v.id, name: v.name })),
      templates: rankedTemplates.map((t) => ({ ...t, description: byId.get(t.id)?.description ?? null, preview: sequencePreview(byId.get(t.id)?.sequences) })),
      accounts: instantly.accounts.map((a) => ({ email: a.email, status: a.status, warmup_score: a.warmup_score })),
      sources,
    },
    instantly: { configured: instantly.configured, ...(instantly.error ? { error: instantly.error } : {}) },
  }
}
