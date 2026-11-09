import { jobName } from '@/lib/validate/jobs'

/**
 * Progress: one queue of every live process (pure mappers). Each source
 * becomes a ProgressItem; GET /api/progress (lib/progress/build.ts) gathers
 * them with cheap queries.
 */

export type ProgressKind = 'validation' | 'apify' | 'influencer_run' | 'influencer_lookup' | 'leadsfriday_order' | 'job_batch'

export interface ProgressItem {
  key: string
  kind: ProgressKind
  label: string
  title: string
  status: string
  stage: string | null
  done: number | null
  total: number | null
  eta_seconds: number | null
  eta_updated_at: string | null
  cost_usd: number | null
  cap_usd: number | null
  started_at: string
  updated_at: string
  finished: boolean
  error: string | null
  href: string | null
  external: boolean
  /** Validation jobs: the job, for its progress panel. */
  job_id?: string
  /** The item's tag (lib/tags); vertical_name is filled by buildProgress. */
  vertical_id?: string | null
  vertical_name?: string | null
  /** The table its tag lives in (retaggable from the card); null: shown, not editable. */
  tag_table?: 'validation_jobs' | 'apollo_orders' | 'job_batches' | null
}

const RECENT_MS = 24 * 60 * 60 * 1000
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const base = (o: Partial<ProgressItem> & Pick<ProgressItem, 'key' | 'kind' | 'label' | 'title' | 'status' | 'started_at' | 'updated_at' | 'finished'>): ProgressItem => ({
  stage: null,
  done: null,
  total: null,
  eta_seconds: null,
  eta_updated_at: null,
  cost_usd: null,
  cap_usd: null,
  error: null,
  href: null,
  external: false,
  ...o,
})

export interface ValidationJobLike {
  id: string
  filename: string | null
  display_name?: string | null
  status: string | null
  total_rows: number
  processed_rows: number
  valid_count?: number
  enrich?: boolean
  enrich_started?: boolean
  enriched_rows?: number
  instantly_status?: string | null
  eta_seconds?: number | null
  eta_updated_at?: string | null
  created_at: string
  updated_at: string
  error_message: string | null
  vertical_id?: string | null
}

const LIVE_JOB = new Set(['pending', 'processing'])

/** validating → retry pass → enriching (city) → pushing, by what the job is doing now. */
export function fromValidationJob(j: ValidationJobLike): ProgressItem {
  const live = LIVE_JOB.has(j.status ?? '')
  const pushing = j.instantly_status === 'pushing'
  const enriching = !pushing && !!j.enrich_started && j.processed_rows >= j.total_rows
  const validating = j.processed_rows < j.total_rows
  const stage = !live ? null : pushing ? 'pushing' : enriching ? 'enriching (city)' : validating ? 'validating' : 'retry pass'
  const [done, total] = enriching ? [j.enriched_rows ?? 0, j.valid_count ?? 0] : [j.processed_rows, j.total_rows]
  return base({
    key: `validation:${j.id}`,
    kind: 'validation',
    label: 'Validation',
    title: jobName(j),
    status: j.status ?? 'unknown',
    stage,
    done,
    total,
    eta_seconds: live ? (j.eta_seconds ?? null) : null,
    eta_updated_at: live ? (j.eta_updated_at ?? null) : null,
    started_at: j.created_at,
    updated_at: j.updated_at,
    finished: !live,
    error: j.status === 'failed' || j.status === 'cancelled' ? (j.error_message?.trim() || 'No reason recorded.') : (j.error_message?.trim() || null),
    href: `/progress?job=${j.id}`,
    job_id: j.id,
    vertical_id: j.vertical_id ?? null,
    tag_table: 'validation_jobs',
  })
}

export interface ApifyRunLike {
  id: string
  actorId: string | null
  status: string
  statusMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  usageTotalUsd: number | null
  itemCount: number | null
  consoleUrl: string
}

const LIVE_APIFY = new Set(['READY', 'RUNNING'])

export function fromApifyRun(r: ApifyRunLike): ProgressItem {
  const live = LIVE_APIFY.has(r.status)
  const started = r.startedAt ?? r.finishedAt ?? new Date(0).toISOString()
  return base({
    key: `apify:${r.id}`,
    kind: 'apify',
    label: 'Apify run',
    title: r.actorId ?? r.id,
    status: r.status.toLowerCase().replace(/_/g, ' '),
    done: r.itemCount,
    cost_usd: r.usageTotalUsd,
    started_at: started,
    updated_at: r.finishedAt ?? started,
    finished: !live,
    error: !live && r.status !== 'SUCCEEDED' ? (r.statusMessage ?? r.status.toLowerCase()) : null,
    href: r.consoleUrl,
    external: true,
  })
}

export interface InfluencerRunLike {
  id: string
  status: string
  stage: string | null
  influencer_ids: string[]
  cost: Record<string, unknown> | null
  counts: Record<string, unknown> | null
  error: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

const LIVE_INF_RUN = new Set(['running', 'awaiting_approval'])

export function fromInfluencerRun(r: InfluencerRunLike): ProgressItem {
  const n = r.influencer_ids.length
  return base({
    key: `influencer_run:${r.id}`,
    kind: 'influencer_run',
    label: 'Influencer run',
    title: `${n} influencer${n === 1 ? '' : 's'}`,
    status: r.status.replace(/_/g, ' '),
    stage: r.stage,
    cost_usd: num(r.cost?.total_usd),
    started_at: r.created_at,
    updated_at: r.finished_at ?? r.updated_at,
    finished: !LIVE_INF_RUN.has(r.status),
    error: r.error,
    href: '/import/leads',
  })
}

export interface LookupBatchLike {
  id: string
  name: string
  status: string
  spent_usd: number | string
  max_lookup_usd: number | string | null
  error: string | null
  created_at: string
  updated_at: string
}

export function fromLookupBatch(b: LookupBatchLike, counts: Record<string, number>, listId: string | null): ProgressItem {
  const total = Object.values(counts).reduce((n, v) => n + v, 0)
  return base({
    key: `influencer_lookup:${b.id}`,
    kind: 'influencer_lookup',
    label: 'LinkedIn lookup',
    title: b.name,
    status: b.status.replace(/_/g, ' '),
    done: total - (counts.pending_lookup ?? 0),
    total,
    cost_usd: num(b.spent_usd),
    cap_usd: num(b.max_lookup_usd),
    started_at: b.created_at,
    updated_at: b.updated_at,
    finished: b.status !== 'looking_up',
    error: b.error,
    href: listId ? `/import/leads?list=${listId}` : '/import/leads',
  })
}

export interface ApolloOrderLike {
  id: string
  status: string
  contact_count: number | null
  leadsfriday_status: string | null
  error: string | null
  created_at: string
  updated_at: string
  vertical_id?: string | null
}

const LIVE_ORDER = new Set(['ordering', 'ordered'])

export function fromApolloOrder(o: ApolloOrderLike): ProgressItem {
  return base({
    key: `leadsfriday_order:${o.id}`,
    kind: 'leadsfriday_order',
    label: 'Leadsfriday order',
    title: o.contact_count ? `${o.contact_count.toLocaleString('en-US')} contacts` : 'Apollo order',
    status: o.status,
    stage: o.leadsfriday_status,
    started_at: o.created_at,
    updated_at: o.updated_at,
    finished: !LIVE_ORDER.has(o.status),
    error: o.error,
    href: '/import',
    vertical_id: o.vertical_id ?? null,
    tag_table: 'apollo_orders',
  })
}

export interface JobBatchLike {
  id: string
  status: string
  batch_date: string | null
  companies_pulled: number | null
  companies_added: number | null
  contacts_total: number | null
  error: string | null
  created_at: string
  updated_at: string
  vertical_id?: string | null
}

const LIVE_BATCH = new Set(['resolving', 'ordered', 'delivered'])

export function fromJobBatch(b: JobBatchLike): ProgressItem {
  return base({
    key: `job_batch:${b.id}`,
    kind: 'job_batch',
    label: 'Job-search batch',
    title: b.batch_date ? `Jobs · ${b.batch_date}` : 'Jobs batch',
    status: b.status,
    stage: b.status,
    done: b.status === 'resolving' ? b.companies_added : b.contacts_total,
    total: b.status === 'resolving' ? b.companies_pulled : null,
    started_at: b.created_at,
    updated_at: b.updated_at,
    finished: !LIVE_BATCH.has(b.status),
    error: b.error,
    href: '/import',
    vertical_id: b.vertical_id ?? null,
    tag_table: 'job_batches',
  })
}

export interface ProgressPayload {
  running: ProgressItem[]
  recent: ProgressItem[]
  /** Sources that could not be read this time (shown as a quiet note, never an error page). */
  unavailable?: string[]
}

/** Live items newest first; finished within 24 h, newest update first; older finished ones dropped. */
export function partitionProgress(items: readonly ProgressItem[], now = Date.now()): ProgressPayload {
  const running = items.filter((i) => !i.finished).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
  const recent = items
    .filter((i) => i.finished && now - Date.parse(i.updated_at) <= RECENT_MS)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  return { running, recent }
}

/**
 * Names for the tags (buildProgress): every item with a vertical_id gets its
 * vertical's name; influencer runs and lookups (PM reactions by nature, no
 * column of their own) get `pmReactions`, read-only.
 */
export function withTagNames(items: readonly ProgressItem[], verticals: readonly { id: string; name: string; key?: string | null }[]): ProgressItem[] {
  const byId = new Map(verticals.map((v) => [v.id, v.name]))
  const pm = verticals.find((v) => v.key === 'pm_reactions') ?? null
  return items.map((i) => {
    if (i.kind === 'influencer_run' || i.kind === 'influencer_lookup') {
      return pm ? { ...i, vertical_id: pm.id, vertical_name: pm.name, tag_table: null } : i
    }
    return i.vertical_id ? { ...i, vertical_name: byId.get(i.vertical_id) ?? null } : i
  })
}

/** 5 s while anything runs, else 60 s. */
export const pollInterval = (data: Pick<ProgressPayload, 'running'> | undefined) => (data?.running.length ? 5_000 : 60_000)
