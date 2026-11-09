import type { GateRow, JobProgress } from '@/lib/db/types'
import { liveEta } from '@/lib/validate/eta'
import { sourceLabel } from '@/lib/validate/stats'

/**
 * Pure: one CSV run as a pipeline — Imported → Approved → (Find emails) →
 * Validate → (Enrich) → Campaign → Review → Push → Launch — each step's
 * state and a few numbers, from the job's progress and the run's open
 * gates. Find emails shows only when the finder was involved; Enrich only
 * when enrichment was chosen (or the CSV still waits at approval, where it
 * is still a choice).
 */

export type StepId = 'imported' | 'approved' | 'finder' | 'validate' | 'enrich' | 'campaign' | 'review' | 'push' | 'launch'
export type StepState = 'done' | 'active' | 'needs_you' | 'failed' | 'skipped' | 'todo'

export interface FlowNode {
  id: StepId
  label: string
  state: StepState
  /** Short facts under the node (tabular numbers). */
  metrics: string[]
  /** Active steps with a measurable amount. */
  progress?: { done: number; total: number }
  eta?: string | null
  /** The open gate this step waits on (needs_you). */
  gate?: GateRow
}

export const STEP_LABEL: Record<StepId, string> = {
  imported: 'Imported',
  approved: 'Approved',
  finder: 'Find emails',
  validate: 'Validate',
  enrich: 'Enrich',
  campaign: 'Campaign',
  review: 'Review',
  push: 'Push',
  launch: 'Launch',
}

export const STATE_WORD: Record<StepState, string> = {
  done: 'Done',
  active: 'Running',
  needs_you: 'Your move',
  failed: 'Failed',
  skipped: 'Skipped',
  todo: 'Not started',
}

export interface FlowInput {
  /** The validation job (null while the CSV waits at approval). */
  job: JobProgress | null
  /** Open gates of this run (runOfGate). */
  gates: readonly GateRow[]
  /** The Instantly campaign's status label (draft / active / paused …), when known. */
  campaignStatus?: string | null
  /** The instantly-push preview's routing, when read (review / confirm). Missing route = 'direct'. */
  route?: PushRoute | null
  now?: number
}

/**
 * Lead-bank routing (instantly-push preview, optional fields): with
 * `route: 'bank'` the leads go to the lead bank and rotate into the campaign
 * as slots free instead of being pushed straight in. Absent = direct.
 */
export interface PushRoute {
  route?: 'bank' | 'direct' | string | null
  banked_estimate?: number | null
  threshold?: number | null
}

export const isBankRoute = (r: PushRoute | null | undefined): boolean => r?.route === 'bank'

/** Pushed / banked counts for a job, tolerant of the optional `instantly_banked` column. */
export function bankedCount(job: Pick<JobProgress, 'id'> & { instantly_banked?: number | null }): number {
  return typeof job.instantly_banked === 'number' ? job.instantly_banked : 0
}

const fmt = new Intl.NumberFormat('en-US')
const n = (v: number) => fmt.format(v)
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(whole >= 1000 ? 1 : 0)}%` : null)
const LIVE = new Set(['pending', 'processing'])
const LAUNCHED = new Set(['active', 'completed', 'running_subsequences'])
const PICKING = new Set(['awaiting_campaign', 'choosing_campaign'])
const REVIEWING = new Set(['configuring', 'reviewing_company'])
const PUSHED_OR_PUSHING = new Set(['pushing', 'done', 'error'])

const node = (id: StepId, state: StepState, metrics: (string | null | undefined | false)[], extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  label: STEP_LABEL[id],
  state,
  metrics: metrics.filter((m): m is string => typeof m === 'string' && m.length > 0),
  ...extra,
})

const gateOf = (gates: readonly GateRow[], kind: GateRow['kind'], title?: string) =>
  gates.find((g) => g.kind === kind && (title === undefined || g.title === title))

/** The CSV still at the approval gate: everything after Imported waits on that tap. */
function ingestFlow(gate: GateRow | undefined): FlowNode[] {
  const rows = typeof gate?.counts?.row_count === 'number' ? gate.counts.row_count : null
  const sender = gate?.subtitle?.match(/from ([^·]+)/)?.[1]?.trim()
  return [
    node('imported', 'done', [rows != null && `${n(rows)} rows`, sender && sender !== '?' && `from ${sender}`]),
    node('approved', gate ? 'needs_you' : 'todo', [gate && gate.actions.length === 1 && gate.actions[0] === 'deny' ? 'no email column' : null], { gate }),
    node('validate', 'todo', []),
    node('enrich', 'todo', ['optional']),
    node('campaign', 'todo', []),
    node('review', 'todo', []),
    node('push', 'todo', []),
    node('launch', 'todo', []),
  ]
}

export function buildFlow({ job, gates, campaignStatus = null, route = null, now = Date.now() }: FlowInput): FlowNode[] {
  if (!job) return ingestFlow(gateOf(gates, 'ingest_approval'))

  const live = LIVE.has(job.status ?? '')
  const jobFailed = job.status === 'failed' || job.status === 'error'
  const inst = job.instantly_status
  const cancelled = inst === 'cancelled'
  const c = job.counts
  const rowsTotal = c.valid + c.invalid + c.error + c.no_email + c.pending
  const total = rowsTotal || job.total_rows
  const verified = rowsTotal ? rowsTotal - c.pending : job.processed_rows

  // Imported / Approved
  const nodes: FlowNode[] = [
    node('imported', 'done', [`${n(job.total_rows)} rows`, job.source ? sourceLabel({ sender_name: null, source: job.source }) : null]),
    node('approved', 'done', [job.enrich ? '+ enrich' : 'validate only']),
  ]

  // Find emails
  const finderGate = gateOf(gates, 'finder_decision')
  const finderWaiting = Boolean(finderGate) || job.finder_status === 'awaiting_decision'
  if (finderGate || job.finder_status || (job.rows_missing_email ?? 0) > 0) {
    const missing = job.rows_missing_email ?? 0
    nodes.push(
      node('finder', finderWaiting ? 'needs_you' : 'done', [missing ? `${n(missing)} missing` : null, !finderWaiting && `${n(job.emails_found ?? 0)} found`], {
        gate: finderGate,
      })
    )
  }

  // Validate
  const stallGate = gateOf(gates, 'stall')
  const validateDone = job.status === 'completed' || (live && c.pending === 0 && total > 0 && job.processed_rows >= job.total_rows)
  const decided = c.valid + c.invalid
  const validateMetrics = [`${n(verified)} / ${n(total)}`, decided ? `${n(c.valid)} valid` : null, decided ? `${pct(c.invalid, decided)} invalid` : null]
  let validate: FlowNode
  if (stallGate) validate = node('validate', 'needs_you', ['stalled', ...validateMetrics], { gate: stallGate })
  else if (finderWaiting) validate = node('validate', 'todo', [])
  else if (jobFailed && !validateDone) validate = node('validate', 'failed', validateMetrics)
  else if (validateDone) validate = node('validate', 'done', validateMetrics)
  else if (live) {
    const eta = liveEta(job, now)
    validate = node('validate', 'active', validateMetrics, { progress: { done: verified, total }, eta: job.eta_stage === 'enriching' ? null : eta })
  } else validate = node('validate', job.status === 'cancelled' ? 'skipped' : 'todo', validateMetrics)
  nodes.push(validate)

  // Enrich
  if (job.enrich) {
    const of = `${n(job.enriched_rows)} / ${n(c.valid)}`
    let enrich: FlowNode
    if (!validateDone) enrich = node('enrich', jobFailed ? 'skipped' : 'todo', [])
    else if (live) enrich = node('enrich', 'active', [job.enrich_started ? of : 'queued'], { progress: { done: job.enriched_rows, total: c.valid }, eta: job.eta_stage === 'enriching' ? liveEta(job, now) : null })
    else if (jobFailed) enrich = node('enrich', 'failed', [of])
    else enrich = node('enrich', 'done', [`${n(job.enriched_rows)} enriched`, c.valid > job.enriched_rows ? `${n(c.valid - job.enriched_rows)} no city` : null])
    nodes.push(enrich)
  }

  const jobDone = job.status === 'completed'
  const after = (id: StepId, s: StepState, metrics: (string | null | false)[] = [], extra: Partial<FlowNode> = {}) => nodes.push(node(id, cancelled ? 'skipped' : s, cancelled ? ['push cancelled'] : metrics, extra))

  // Campaign
  const campaignGate = gateOf(gates, 'campaign_choice')
  const campaignName = job.instantly_campaign_name
  const sibling = job.instantly_campaign_name_nolocation
  if (campaignGate) after('campaign', 'needs_you', [`${n(c.valid)} valid to place`], { gate: campaignGate })
  else if (campaignName && !PICKING.has(inst ?? '')) after('campaign', 'done', [campaignName, sibling ? `+ ${sibling}` : null])
  else after('campaign', 'todo', [jobDone && !inst ? 'not offered' : null])

  // Review (barriers + names)
  const reviewGate = gateOf(gates, 'push_review')
  const pushAction = gateOf(gates, 'lume_action', 'push_to_instantly')
  const barriers = [`location ${job.location_barrier ? 'on' : 'off'}`, `company ${job.company_barrier ? 'on' : 'off'}`]
  if (reviewGate) after('review', 'needs_you', barriers, { gate: reviewGate })
  else if (pushAction || PUSHED_OR_PUSHING.has(inst ?? '')) after('review', 'done', barriers)
  else if (REVIEWING.has(inst ?? '')) after('review', 'active', barriers)
  else after('review', 'todo')

  // Push
  const pushed = job.instantly_pushed ?? 0
  const pushedNoLoc = job.instantly_pushed_nolocation ?? 0
  const banked = bankedCount(job)
  const bank = isBankRoute(route) || banked > 0
  const pushedMetrics = bank
    ? [`${n(banked)} banked`, pushed ? `${n(pushed)} pushed` : null]
    : [`${n(pushed)} pushed`, pushedNoLoc ? `${n(pushedNoLoc)} no-location` : null]
  const planned = isBankRoute(route) && typeof route?.banked_estimate === 'number' ? `${n(route.banked_estimate)} → lead bank` : null
  if (pushAction) after('push', 'needs_you', ['confirm', planned], { gate: pushAction })
  else if (inst === 'pushing') after('push', 'active', pushedMetrics, { progress: { done: pushed + pushedNoLoc + banked, total: c.valid } })
  else if (inst === 'done') after('push', 'done', pushedMetrics)
  else if (inst === 'error') after('push', 'failed', pushedMetrics)
  else after('push', 'todo', [planned])

  // Launch
  const launchAction = gateOf(gates, 'lume_action', 'launch_campaign')
  const status = campaignStatus?.replace(/_/g, ' ') ?? null
  if (launchAction) after('launch', 'needs_you', ['confirm'], { gate: launchAction })
  else if (inst === 'done' && campaignStatus && LAUNCHED.has(campaignStatus)) after('launch', 'done', [status])
  else after('launch', 'todo', [inst === 'done' && status ? status : null])

  return nodes
}

/** The step to open: the one waiting on the owner, else a failure, else what runs, else the last finished one. */
export function focusStep(nodes: readonly FlowNode[]): StepId {
  const pick = (s: StepState) => nodes.find((x) => x.state === s)
  const lastDone = [...nodes].reverse().find((x) => x.state === 'done')
  return (pick('needs_you') ?? pick('failed') ?? pick('active') ?? lastDone ?? nodes[0])?.id ?? 'imported'
}
