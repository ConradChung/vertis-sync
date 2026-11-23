/**
 * Pure helpers behind the live run view on `/actions/<id>` (InfluencerRunLive):
 * which run an action started, the stage list and each stage's state, the
 * Apify console links, and the counts / cost lines. No I/O.
 */

export const RUN_ACTION_KINDS = ['influencer_run', 'influencer_reactions'] as const

export type RunStatus = 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled' | 'imported' | string
export type StageState = 'done' | 'active' | 'needs_you' | 'failed' | 'todo'

export interface LiveRun {
  id: string
  status: RunStatus
  stage: string
  counts: Record<string, unknown> | null
  cost: Record<string, unknown> | null
  error: string | null
}

export interface LiveApifyRun {
  influencer_id: string
  kind: string
  status: string
  error: string | null
  cost_usd: number | string | null
  actor_id?: string | null
  apify_run_id?: string | null
  dataset_id?: string | null
  item_count?: number | null
  started_at?: string | null
  finished_at?: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)

/**
 * The run an influencer action points at, from the action row alone:
 * influencer_reactions carries it in its payload, influencer_run in its result
 * once executed. Null = not an influencer action, still awaiting, or unknown
 * (the page then falls back to influencer_runs by action id).
 */
export function runIdFromAction(a: { kind: string; status: string; payload: unknown; result: unknown }): string | null {
  if (!isLiveRunAction(a)) return null
  if (a.kind === 'influencer_reactions') return (isObj(a.payload) && str(a.payload.run_id)) || (isObj(a.result) && str(a.result.run_id)) || null
  return isObj(a.result) ? str(a.result.run_id) : null
}

/** An influencer action past its decision (approved / executing / executed / failed). */
export function isLiveRunAction(a: { kind: string; status: string }): boolean {
  return (RUN_ACTION_KINDS as readonly string[]).includes(a.kind) && a.status !== 'awaiting' && a.status !== 'rejected' && a.status !== 'expired'
}

/** Keep polling while the edge function can still move the run. */
export const isRunLive = (status: RunStatus) => status === 'running' || status === 'awaiting_approval'

/** A run on chosen posts (targeted) skips posts + top_posts. */
export function isTargeted(run: Pick<LiveRun, 'counts'>): boolean {
  return isObj(run.counts) && run.counts.targeted_posts !== undefined && run.counts.targeted_posts !== null
}

export const STAGE_LABEL: Record<string, string> = {
  posts: 'Posts',
  top_posts: 'Top posts',
  reactions: 'Reactions',
  triage: 'Triage',
  verify: 'Verify',
  doors: 'Doors',
  output: 'Output',
}

const ALL_STAGES = ['posts', 'top_posts', 'reactions', 'triage', 'verify', 'doors', 'output']

export function stageList(run: Pick<LiveRun, 'counts'>): string[] {
  return isTargeted(run) ? ALL_STAGES.slice(2) : ALL_STAGES
}

/**
 * Each stage's state: before the current one done, the current one active
 * (needs_you while the run awaits the reactions bill, failed when the run
 * failed or was cancelled), after it todo. A done / imported run is all done.
 */
export function stageStates(run: Pick<LiveRun, 'counts' | 'stage' | 'status'>): { id: string; label: string; state: StageState }[] {
  const list = stageList(run)
  const finished = run.status === 'done' || run.status === 'imported'
  const at = list.indexOf(run.stage)
  return list.map((id, i) => {
    let state: StageState
    if (finished) state = 'done'
    else if (at < 0) state = 'todo'
    else if (i < at) state = 'done'
    else if (i > at) state = 'todo'
    else if (run.status === 'awaiting_approval') state = 'needs_you'
    else if (run.status === 'failed' || run.status === 'cancelled') state = 'failed'
    else state = 'active'
    return { id, label: STAGE_LABEL[id] ?? id, state }
  })
}

export const apifyRunUrl = (apifyRunId: string) => `https://console.apify.com/actors/runs/${encodeURIComponent(apifyRunId)}`
export const apifyDatasetUrl = (datasetId: string) => `https://console.apify.com/storage/datasets/${encodeURIComponent(datasetId)}`

export const isApifyPending = (status: string) => status === 'pending' || status === 'running'

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

export const usd = (v: unknown) => {
  const n = num(v)
  return n === null ? '—' : `$${n.toFixed(2)}`
}

/** The counts worth showing, in pipeline order, present keys only. */
const COUNT_KEYS: [string, string][] = [
  ['posts', 'posts'],
  ['top_posts', 'top posts'],
  ['reactions', 'reactions'],
  ['unique_reactors', 'unique reactors'],
  ['new_reactors', 'new reactors'],
  ['new_reactors_merged', 'new reactors'],
  ['candidates', 'PM candidates'],
  ['verified', 'verified'],
  ['with_door_count', 'with door count'],
  ['leads_700', '700+ doors'],
]

export function countLines(counts: Record<string, unknown> | null): { key: string; label: string; value: number }[] {
  if (!isObj(counts)) return []
  const out: { key: string; label: string; value: number }[] = []
  for (const [key, label] of COUNT_KEYS) {
    // new_reactors (final) supersedes the running new_reactors_merged tally
    if (key === 'new_reactors_merged' && counts.new_reactors !== undefined) continue
    const v = num(counts[key])
    if (v !== null) out.push({ key, label, value: v })
  }
  return out
}

/** Every numeric cost key, `total` last. */
export function costLines(cost: Record<string, unknown> | null): { key: string; label: string; value: string }[] {
  if (!isObj(cost)) return []
  const keys = Object.keys(cost).filter((k) => num(cost[k]) !== null)
  keys.sort((a, b) => (a === 'total' ? 1 : b === 'total' ? -1 : 0))
  return keys.map((k) => ({ key: k, label: k.replaceAll('_', ' '), value: usd(cost[k]) }))
}
