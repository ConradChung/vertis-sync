import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { getRun, isApifyConfigured, listAccountRuns, type AccountRun } from '@/lib/adapters/apify'
import { listRecentJobs } from '@/lib/db/service'
import { sheetsForBatches } from '@/lib/leads/lists/influencerSheets'
import {
  fromApifyRun,
  fromApolloOrder,
  fromInfluencerRun,
  fromJobBatch,
  fromLookupBatch,
  fromValidationJob,
  partitionProgress,
  type ApifyRunLike,
  type ProgressItem,
  type ProgressPayload,
} from '@/lib/progress/model'

/**
 * GET /api/progress: every live process (validation jobs, Apify runs,
 * influencer reaction runs, LinkedIn lookups, Leadsfriday orders, job-search
 * batches) plus those finished in the last 24 h. Each source is one cheap
 * query and fails on its own (listed in `unavailable`). Apify's getRun is
 * called only for runs that are live, at most MAX_LIVE_APIFY.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_LIVE_APIFY = 10

/**
 * Apify answers are reused for APIFY_CACHE_MS (per instance): with the 5 s
 * poll, the account listing and each live run's getRun are fetched about
 * every other poll instead of every one.
 */
export const APIFY_CACHE_MS = 10_000
let accountCache: { at: number; value: Promise<AccountRun[]> } | null = null
const runCache = new Map<string, { at: number; value: Promise<Awaited<ReturnType<typeof getRun>>> }>()

/** Tests only: start with empty caches. */
export function resetApifyCache(): void {
  accountCache = null
  runCache.clear()
}

function cachedAccountRuns(): Promise<AccountRun[]> {
  const now = Date.now()
  if (accountCache && now - accountCache.at < APIFY_CACHE_MS) return accountCache.value
  const value = listAccountRuns(20)
  accountCache = { at: now, value }
  // A failure is not cached: the next poll asks again.
  value.catch(() => {
    if (accountCache?.value === value) accountCache = null
  })
  return value
}

function cachedRun(id: string) {
  const now = Date.now()
  const hit = runCache.get(id)
  if (hit && now - hit.at < APIFY_CACHE_MS) return hit.value
  const value = getRun(id)
  runCache.set(id, { at: now, value })
  value.catch(() => {
    if (runCache.get(id)?.value === value) runCache.delete(id)
  })
  // Keep the map small: drop entries well past their life.
  for (const [k, v] of runCache) if (now - v.at > APIFY_CACHE_MS * 6) runCache.delete(k)
  return value
}
const LIVE_APIFY = new Set(['READY', 'RUNNING'])

type Source = { name: string; load: () => Promise<ProgressItem[]> }

export async function buildProgress(now = new Date()): Promise<ProgressPayload> {
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  const sb = createServiceClient()

  const sources: Source[] = [
    { name: 'validation', load: async () => (await listRecentJobs(new Date(now.getTime() - DAY_MS))).map(fromValidationJob) },
    { name: 'apify', load: () => apifyItems(since) },
    {
      name: 'influencer_runs',
      load: async () => {
        const { data, error } = await sb
          .from('influencer_runs')
          .select('id,status,stage,influencer_ids,cost,counts,error,created_at,updated_at,finished_at')
          .or(`status.in.(running,awaiting_approval),updated_at.gte.${since}`)
          .order('created_at', { ascending: false })
          .limit(20)
        if (error) throw error
        return (data ?? []).map((r) => fromInfluencerRun(r as never))
      },
    },
    {
      name: 'influencer_lookups',
      load: async () => {
        const { data, error } = await sb
          .from('influencer_candidate_batches')
          .select('id,name,status,spent_usd,max_lookup_usd,error,created_at,updated_at')
          .or(`status.eq.looking_up,and(status.in.(done,capped,failed),updated_at.gte.${since})`)
          .limit(20)
        if (error) throw error
        const batches = (data ?? []) as { id: string }[]
        if (!batches.length) return []
        const [counts, sheets] = await Promise.all([lookupCounts(batches.map((b) => b.id)), sheetsForBatches(batches.map((b) => b.id))])
        return batches.map((b) => fromLookupBatch(b as never, counts.get(b.id) ?? {}, sheets.get(b.id) ?? null))
      },
    },
    {
      name: 'leadsfriday_orders',
      load: async () => {
        const { data, error } = await sb
          .from('apollo_orders')
          .select('id,status,contact_count,leadsfriday_status,error,created_at,updated_at')
          .or(`status.in.(ordering,ordered),updated_at.gte.${since}`)
          .order('created_at', { ascending: false })
          .limit(20)
        if (error) throw error
        return (data ?? []).map((o) => fromApolloOrder(o as never))
      },
    },
    {
      name: 'job_batches',
      load: async () => {
        const { data, error } = await sb
          .from('job_batches')
          .select('id,status,batch_date,companies_pulled,companies_added,contacts_total,error,created_at,updated_at')
          .or(`status.in.(resolving,ordered,delivered),updated_at.gte.${since}`)
          .order('created_at', { ascending: false })
          .limit(20)
        if (error) throw error
        return (data ?? []).map((b) => fromJobBatch(b as never))
      },
    },
  ]

  const settled = await Promise.allSettled(sources.map((s) => s.load()))
  const items: ProgressItem[] = []
  const unavailable: string[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value)
    else {
      unavailable.push(sources[i].name)
      console.error(`[progress] ${sources[i].name}:`, r.reason instanceof Error ? r.reason.message : r.reason)
    }
  })
  const out = partitionProgress(items, now.getTime())
  return unavailable.length ? { ...out, unavailable } : out
}

/** Per-batch status counts for the lookups in the queue (one query). */
async function lookupCounts(batchIds: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>()
  const { data, error } = await createServiceClient().from('influencer_candidates').select('batch_id,status').in('batch_id', batchIds).limit(20_000)
  if (error) throw error
  for (const r of (data ?? []) as { batch_id: string; status: string }[]) {
    const c = out.get(r.batch_id) ?? {}
    c[r.status] = (c[r.status] ?? 0) + 1
    out.set(r.batch_id, c)
  }
  return out
}

const accountRunItem = (r: AccountRun): ApifyRunLike => ({
  id: r.run_id,
  actorId: r.actor_id,
  status: r.status,
  statusMessage: null,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  usageTotalUsd: r.cost_usd,
  itemCount: null,
  consoleUrl: r.console_url,
})

/**
 * Runs Lume started (approved run_actor actions of the last 24 h) and the
 * account's recent runs. Only live ones get a getRun call (items + cost so
 * far), at most MAX_LIVE_APIFY; a failing call keeps the list row.
 */
async function apifyItems(since: string): Promise<ProgressItem[]> {
  if (!isApifyConfigured()) return []
  const [account, approved] = await Promise.all([
    cachedAccountRuns(),
    createServiceClient().from('pending_actions').select('result').eq('kind', 'run_actor').eq('status', 'executed').gte('updated_at', since).limit(20),
  ])
  if (approved.error) throw approved.error
  const byId = new Map<string, ApifyRunLike>()
  for (const r of account) {
    const recent = !r.finished_at || Date.parse(r.finished_at) >= Date.parse(since)
    if (LIVE_APIFY.has(r.status) || recent) byId.set(r.run_id, accountRunItem(r))
  }
  const lumeIds = (approved.data ?? []).map((a) => (a.result as { run_id?: unknown } | null)?.run_id).filter((x): x is string => typeof x === 'string')
  // A Lume run missing from the account page is assumed live until getRun says otherwise.
  const live = [...new Set([...[...byId.values()].filter((r) => LIVE_APIFY.has(r.status)).map((r) => r.id), ...lumeIds.filter((id) => !byId.has(id))])].slice(0, MAX_LIVE_APIFY)
  const runs = await Promise.allSettled(live.map((id) => cachedRun(id)))
  runs.forEach((r) => {
    if (r.status === 'fulfilled') byId.set(r.value.id, { ...r.value, itemCount: r.value.itemCount })
  })
  return [...byId.values()].map(fromApifyRun)
}
