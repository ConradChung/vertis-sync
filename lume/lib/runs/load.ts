import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { getRun as getApifyRun, isApifyConfigured } from '@/lib/adapters/apify'
import { getApifyRuns, getInfluencersByIds, getRun as getInfluencerRun, type ApifyRunRow, type InfluencerRun } from '@/lib/influencers/store'
import { checkSummary, getCheckJob, getCheckRunById, type CheckJob, type CheckRun, type CheckSummary } from '@/lib/companyCheck/store'
import { sheetsForBatches } from '@/lib/leads/lists/influencerSheets'
import type { ReactorRow, SignalPostRow } from '@/lib/runs/model'

/**
 * Thin fetches behind `/runs/<kind>/<id>` (service role; the page checks the
 * owner first). Read-only, only the columns the views show. Each returns null
 * when the row does not exist (→ 404). Pure mapping is in lib/runs/model.ts.
 */

const db = () => createServiceClient()

/** Max reactors read for one run's people table (a full historical import can be ~7.6k). */
export const MAX_REACTORS = 5_000

// ── Influencer run ────────────────────────────────────────────────────────

export interface RunPost {
  influencer_id: string
  post_id: string
  post_url: string
  posted_at: string | null
  likes: number
  comments: number
  rank: number | null
  pm_relevant: boolean | null
}

export interface InfluencerRunDetail {
  run: InfluencerRun
  influencers: { id: string; name: string; slug: string }[]
  posts: RunPost[]
  signalPosts: SignalPostRow[]
  reactors: ReactorRow[]
  reactorsTruncated: boolean
  exports: { id: string; row_count: number; created_at: string }[]
  apify: ApifyRunRow[]
}

const REACTOR_COLS = 'id,name,headline,linkedin_url,triage,verdict,verify_reason,skip_reason,company_name,company_website,door_count,exported_at,first_seen_run,last_seen_run'

async function runReactors(runId: string): Promise<{ rows: ReactorRow[]; truncated: boolean }> {
  const rows: ReactorRow[] = []
  for (let from = 0; from < MAX_REACTORS; from += 1000) {
    const res = await db()
      .from('influencer_reactors')
      .select(REACTOR_COLS)
      .or(`last_seen_run.eq.${runId},first_seen_run.eq.${runId}`)
      .order('id')
      .range(from, Math.min(from + 999, MAX_REACTORS - 1))
    if (res.error) throw new DbError('runReactors', res.error)
    const page = (res.data ?? []) as unknown as ReactorRow[]
    rows.push(...page)
    if (page.length < 1000) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

export async function loadInfluencerRun(id: string): Promise<InfluencerRunDetail | null> {
  const run = await getInfluencerRun(id)
  if (!run) return null
  const sb = db()
  const [influencers, posts, signal, reactors, exports, apify] = await Promise.all([
    run.influencer_ids.length ? getInfluencersByIds(run.influencer_ids) : Promise.resolve([]),
    sb.from('influencer_posts').select('influencer_id,post_id,post_url,posted_at,likes,comments,rank,pm_relevant').eq('run_id', id).order('rank', { ascending: true, nullsFirst: false }).limit(200),
    sb
      .from('signal_posts')
      .select('post_id,post_url,posted_at,reactions_status,digest_status,digest_posted_at')
      .or(`reactions_run_id.eq.${id}${run.start_action_id ? `,reactions_action_id.eq.${run.start_action_id}` : ''}${run.reactions_action_id ? `,reactions_action_id.eq.${run.reactions_action_id}` : ''}`)
      .order('posted_at', { ascending: false })
      .limit(50),
    runReactors(id),
    sb.from('influencer_exports').select('id,row_count,created_at').eq('filters->>run_id', id).order('created_at', { ascending: false }).limit(20),
    getApifyRuns(id),
  ])
  if (posts.error) throw new DbError('runPosts', posts.error)
  if (signal.error) throw new DbError('runSignalPosts', signal.error)
  if (exports.error) throw new DbError('runExports', exports.error)
  return {
    run,
    influencers: influencers.map((i) => ({ id: i.id, name: i.name, slug: i.slug })),
    posts: (posts.data ?? []) as RunPost[],
    signalPosts: (signal.data ?? []) as SignalPostRow[],
    reactors: reactors.rows,
    reactorsTruncated: reactors.truncated,
    exports: (exports.data ?? []) as { id: string; row_count: number; created_at: string }[],
    apify,
  }
}

// ── Company check ─────────────────────────────────────────────────────────

export interface CheckedCompany {
  company_key: string
  company_name: string | null
  website: string | null
  leads: number
  status: 'cached' | 'done' | 'error'
  error: string | null
  icp_fit: 'fit' | 'not_fit' | 'unclear' | null
  confidence: 'high' | 'medium' | 'low' | null
  property_type: string | null
  doors: number | null
  what_it_does: string | null
  check_cost_usd: number | string | null
}

export const MAX_CHECKED = 1_000

export interface CompanyCheckDetail {
  run: CheckRun
  job: CheckJob | null
  summary: CheckSummary | null
  companies: CheckedCompany[]
  truncated: boolean
}

export async function loadCompanyCheck(id: string): Promise<CompanyCheckDetail | null> {
  const run = await getCheckRunById(id)
  if (!run) return null
  const [job, summary, res] = await Promise.all([
    getCheckJob(run.job_id),
    checkSummary(id).catch(() => null),
    db()
      .from('company_check_results')
      .select('company_key,company_name,website,leads,status,error,icp_fit,confidence,property_type,doors,what_it_does,check_cost_usd')
      .eq('run_id', id)
      .neq('status', 'pending')
      .order('leads', { ascending: false })
      .order('company_key')
      .limit(MAX_CHECKED + 1),
  ])
  if (res.error) throw new DbError('checkedCompanies', res.error)
  const rows = (res.data ?? []) as CheckedCompany[]
  return { run, job, summary, companies: rows.slice(0, MAX_CHECKED), truncated: rows.length > MAX_CHECKED }
}

// ── LinkedIn lookup ───────────────────────────────────────────────────────

export interface LookupDetail {
  batch: { id: string; name: string; status: string; spent_usd: number | string; max_lookup_usd: number | string | null; error: string | null; lookup_action_id: string | null; created_at: string; updated_at: string }
  counts: Record<string, number>
  listId: string | null
}

export async function loadLookup(id: string): Promise<LookupDetail | null> {
  const sb = db()
  const res = await sb.from('influencer_candidate_batches').select('id,name,status,spent_usd,max_lookup_usd,error,lookup_action_id,created_at,updated_at').eq('id', id).maybeSingle()
  if (res.error) throw new DbError('loadLookup', res.error)
  if (!res.data) return null
  const [cands, sheets] = await Promise.all([sb.from('influencer_candidates').select('status').eq('batch_id', id).limit(20_000), sheetsForBatches([id])])
  if (cands.error) throw new DbError('loadLookup.candidates', cands.error)
  const counts: Record<string, number> = {}
  for (const r of (cands.data ?? []) as { status: string }[]) counts[r.status] = (counts[r.status] ?? 0) + 1
  return { batch: res.data as LookupDetail['batch'], counts, listId: sheets.get(id) ?? null }
}

// ── Leadsfriday order ─────────────────────────────────────────────────────

export interface OrderDetail {
  id: string
  apollo_url: string | null
  contact_count: number | null
  status: string
  leadsfriday_order_id: number | null
  leadsfriday_status: string | null
  credits_deducted: number | string | null
  new_balance: number | string | null
  ingest_id: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export async function loadOrder(id: string): Promise<OrderDetail | null> {
  const res = await db()
    .from('apollo_orders')
    .select('id,apollo_url,contact_count,status,leadsfriday_order_id,leadsfriday_status,credits_deducted,new_balance,ingest_id,error,created_at,updated_at')
    .eq('id', id)
    .maybeSingle()
  if (res.error) throw new DbError('loadOrder', res.error)
  return (res.data as OrderDetail | null) ?? null
}

// ── Job-search batch ──────────────────────────────────────────────────────

export interface JobBatchDetail {
  id: string
  batch_date: string | null
  status: string
  companies_added: number
  companies_pulled: number
  companies_unresolved: number
  apollo_url: string | null
  leadsfriday_order_id: number | null
  leadsfriday_status: string | null
  contacts_total: number
  contacts_kept: number
  error: string | null
  created_at: string
  updated_at: string
}

export async function loadJobBatch(id: string): Promise<JobBatchDetail | null> {
  const res = await db()
    .from('job_batches')
    .select('id,batch_date,status,companies_added,companies_pulled,companies_unresolved,apollo_url,leadsfriday_order_id,leadsfriday_status,contacts_total,contacts_kept,error,created_at,updated_at')
    .eq('id', id)
    .maybeSingle()
  if (res.error) throw new DbError('loadJobBatch', res.error)
  return (res.data as JobBatchDetail | null) ?? null
}

// ── Apify ─────────────────────────────────────────────────────────────────

export type ApifyDetail =
  | { configured: false; id: string; consoleUrl: string }
  | { configured: true; id: string; run: Awaited<ReturnType<typeof getApifyRun>> | null; error: string | null; consoleUrl: string }

/** A free GET on Apify's API (no run is started); a 404 or an error still renders the console link. */
export async function loadApify(id: string): Promise<ApifyDetail> {
  const fallback = `https://console.apify.com/actors/runs/${encodeURIComponent(id)}`
  if (!isApifyConfigured()) return { configured: false, id, consoleUrl: fallback }
  try {
    const run = await getApifyRun(id)
    return { configured: true, id, run, error: null, consoleUrl: run.consoleUrl }
  } catch (err) {
    return { configured: true, id, run: null, error: err instanceof Error ? err.message : String(err), consoleUrl: fallback }
  }
}
