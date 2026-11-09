import type { GateKind, GateRow, JobProgress, RunRow } from '@/lib/db/types'
import { jobName } from '@/lib/validate/jobs'
import { parseGateParam } from '@/lib/validate/deepLink'
import type { StepId } from '@/lib/progress/flow'

/**
 * Progress is organised by run: one CSV on its way through the pipeline.
 * A run is a validation job, or — before the owner approves it — the
 * Telegram ingest waiting at the approval gate (`ingest:<id>`; Lume never
 * creates the job itself). Pure.
 */

export type RunStatus = 'needs_you' | 'running' | 'failed' | 'done'

export interface RunSummary {
  /** The validation job's id, or `ingest:<telegram_ingests.id>`. */
  id: string
  kind: 'job' | 'ingest'
  title: string
  filename: string | null
  total_rows: number
  status: string | null
  instantly_status: string | null
  created_at: string
  updated_at: string
  vertical_id: string | null
  vertical_name?: string | null
}

const LIVE = new Set(['pending', 'processing'])
const FAILED = new Set(['failed', 'error', 'cancelled'])
const RUN_ACTION_KINDS = new Set(['push_to_instantly', 'launch_campaign'])

export const ingestRunId = (ingestId: string) => `ingest:${ingestId}`
export const isIngestRun = (id: string) => id.startsWith('ingest:')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `?run=<job id>` or `?run=ingest:<ingest id>`; anything else is ignored. */
export function parseRunParam(v: string | null | undefined): string | null {
  const s = v?.trim()
  if (!s) return null
  if (UUID_RE.test(s)) return s.toLowerCase()
  if (s.startsWith('ingest:') && UUID_RE.test(s.slice(7))) return `ingest:${s.slice(7).toLowerCase()}`
  return null
}

/** The run a gate is about, or null for gates outside CSV runs (job batches, orders, other confirmations). */
export function runOfGate(g: Pick<GateRow, 'kind' | 'target_table' | 'target_id' | 'title' | 'counts'>): string | null {
  if (g.kind === 'ingest_approval') return ingestRunId(g.target_id)
  if (g.target_table === 'validation_jobs') return g.target_id
  if (g.kind === 'lume_action' && RUN_ACTION_KINDS.has(g.title ?? '') && typeof g.counts?.job_id === 'string') return g.counts.job_id
  return null
}

const STEP_OF_KIND: Partial<Record<GateKind, StepId>> = {
  ingest_approval: 'approved',
  finder_decision: 'finder',
  stall: 'validate',
  campaign_choice: 'campaign',
  push_review: 'review',
}

/** The flow step a run's gate belongs to. */
export function stepOfGate(g: Pick<GateRow, 'kind' | 'title'>): StepId | null {
  if (g.kind === 'lume_action') return g.title === 'push_to_instantly' ? 'push' : g.title === 'launch_campaign' ? 'launch' : null
  return STEP_OF_KIND[g.kind] ?? null
}

export const gatesForRun = (gates: readonly GateRow[], runId: string) => gates.filter((g) => runOfGate(g) === runId)

export function fromRunRow(r: RunRow): RunSummary {
  return {
    id: r.id,
    kind: 'job',
    title: r.display_name?.trim() || r.filename || jobName({ total_rows: r.total_rows, created_at: r.created_at }),
    filename: r.filename,
    total_rows: r.total_rows,
    status: r.status,
    instantly_status: r.instantly_status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    vertical_id: r.vertical_id,
  }
}

/** A run built from the job's own progress (a `?run=` older than the switcher's list). */
export function fromJobProgress(j: JobProgress): RunSummary {
  const at = j.created_at ?? new Date(0).toISOString()
  return {
    id: j.id,
    kind: 'job',
    title: j.display_name?.trim() || j.filename || jobName({ total_rows: j.total_rows, created_at: at }),
    filename: j.filename,
    total_rows: j.total_rows,
    status: j.status,
    instantly_status: j.instantly_status,
    created_at: at,
    updated_at: at,
    vertical_id: j.vertical_id ?? null,
  }
}

/** CSVs waiting at the approval gate, as runs (subtitle: "<file> · from <sender> · email column <c>"). */
export function ingestRuns(gates: readonly GateRow[]): RunSummary[] {
  return gates
    .filter((g) => g.kind === 'ingest_approval')
    .map((g) => {
      const filename = g.subtitle?.split(' · ')[0]?.trim() || null
      const rows = typeof g.counts?.row_count === 'number' ? g.counts.row_count : 0
      return {
        id: ingestRunId(g.target_id),
        kind: 'ingest' as const,
        title: filename || g.title || 'New CSV',
        filename,
        total_rows: rows,
        status: 'awaiting_approval',
        instantly_status: null,
        created_at: g.created_at,
        updated_at: g.created_at,
        vertical_id: g.vertical_id ?? null,
        vertical_name: g.vertical_name ?? null,
      }
    })
}

/** CSVs older than this are done with (owner, 2026-11-09): the run picker leaves them out. */
export const RUN_MAX_AGE_MS = 122 * 24 * 3600_000

/**
 * Jobs plus waiting ingests from the last 4 months, newest CSV first, one
 * entry per id. `extra` (a deep-linked run) is kept whatever its age.
 */
export function mergeRuns(jobs: readonly RunSummary[], ingests: readonly RunSummary[], extra: readonly RunSummary[] = [], now = Date.now()): RunSummary[] {
  const seen = new Set<string>()
  const out: RunSummary[] = []
  const recent = (r: RunSummary) => now - Date.parse(r.created_at) <= RUN_MAX_AGE_MS
  for (const r of [...ingests.filter(recent), ...jobs.filter(recent), ...extra]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
}

export function runStatus(run: Pick<RunSummary, 'id' | 'status' | 'instantly_status'>, gates: readonly GateRow[]): RunStatus {
  if (gates.some((g) => runOfGate(g) === run.id)) return 'needs_you'
  if (FAILED.has(run.status ?? '') || run.instantly_status === 'error') return 'failed'
  if (LIVE.has(run.status ?? '') || run.instantly_status === 'pushing') return 'running'
  return 'done'
}

/**
 * The run Progress opens on: the most recently active run that is waiting on
 * the owner or still running; otherwise the most recently active run.
 */
export function defaultRunId(runs: readonly RunSummary[], gates: readonly GateRow[]): string | null {
  const byActivity = [...runs].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  const live = byActivity.find((r) => {
    const s = runStatus(r, gates)
    return s === 'needs_you' || s === 'running'
  })
  return (live ?? byActivity[0])?.id ?? null
}

export interface DeepLinkTarget {
  /** The gate's key when it is open now. */
  key: string | null
  runId: string | null
  step: StepId | null
  state: 'open' | 'closed' | 'invalid'
}

/**
 * `?gate=<kind>:<id>` → the run (and step) to open. A closed gate on a
 * validation job still opens that job's run, at the step the gate was for.
 */
export function resolveGateLink(param: string | null | undefined, gates: readonly GateRow[]): DeepLinkTarget | null {
  if (!param) return null
  const ref = parseGateParam(param)
  if (!ref) return { key: null, runId: null, step: null, state: 'invalid' }
  const open = gates.find((g) => g.kind === ref.kind && g.target_id.toLowerCase() === ref.targetId)
  if (open) return { key: ref.key, runId: runOfGate(open), step: stepOfGate(open), state: 'open' }
  const jobKind = ref.kind !== 'ingest_approval' && STEP_OF_KIND[ref.kind]
  return { key: null, runId: jobKind ? ref.targetId : null, step: jobKind || null, state: 'closed' }
}

export interface Selection {
  runId: string | null
  source: 'click' | 'run' | 'gate' | 'default'
}

/** Which run is shown: the owner's click, then `?run=` (or the older `?job=`), then a `?gate=` link's run, then the default. */
export function selectRun(opts: {
  clicked: string | null
  runParam: string | null
  gate: DeepLinkTarget | null
  runs: readonly RunSummary[]
  gates: readonly GateRow[]
}): Selection {
  if (opts.clicked) return { runId: opts.clicked, source: 'click' }
  if (opts.runParam) return { runId: opts.runParam, source: 'run' }
  if (opts.gate?.runId) return { runId: opts.gate.runId, source: 'gate' }
  return { runId: defaultRunId(opts.runs, opts.gates), source: 'default' }
}
