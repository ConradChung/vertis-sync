import type { GateKind, GateRow, PendingActionKind } from '@/lib/db/types'

/**
 * Gate kind → the buttons a card shows. Pure (client and server).
 *
 * `mode` says where a button goes:
 *  - `decide`: `POST /api/gates/decide` with the exact Telegram `callback_data`
 *    (entrypoint allowlist only).
 *  - `create_action`: `POST /api/actions` — a high-risk step (push to
 *    Instantly) becomes a `pending_actions` row; Task 12's executor sends
 *    `push_go:<job>` after confirmation. Never sent from this screen.
 *  - `action_decide`: `POST /api/actions/<id>/decide` (Confirm/Cancel of a
 *    pending action).
 *  - `panel`: a Lume-local control in the detail panel (campaign pick).
 *
 * `tone` drives colour and the keyboard: `A` = first approve-like button,
 * `R` = first reject-like one.
 */

export type ButtonTone = 'approve' | 'neutral' | 'reject'
export type ButtonMode = 'decide' | 'create_action' | 'action_decide' | 'panel'

export interface ButtonSpec {
  label: string
  action: string
  mode: ButtonMode
  tone: ButtonTone
  /** Fixed `extra` for the callback (lfo_count presets). */
  count?: number
  /** Asks for a count first (lfo_count custom). */
  needsCount?: boolean
  /** `create_action` only. */
  actionKind?: Extract<PendingActionKind, 'push_to_instantly' | 'launch_campaign'>
}

export const LFO_PRESETS = [500, 1000, 2000, 5000] as const

const d = (label: string, action: string, tone: ButtonTone): ButtonSpec => ({ label, action, mode: 'decide', tone })

export const BUTTON_SPECS: Record<GateKind, readonly ButtonSpec[]> = {
  ingest_approval: [d('Approve', 'approve', 'approve'), d('Approve + Enrich', 'approve_enrich', 'approve'), d('Deny', 'deny', 'reject')],
  finder_decision: [d('Find them first', 'finder_go', 'approve'), d('Validate only', 'finder_skip', 'neutral')],
  campaign_choice: [
    { label: 'Pick campaign', action: 'pick_campaign', mode: 'panel', tone: 'approve' },
    d('Cancel push', 'push_cancel', 'reject'),
  ],
  push_review: [
    { label: 'Push these', action: 'push_to_instantly', mode: 'create_action', tone: 'approve', actionKind: 'push_to_instantly' },
    d('Cancel push', 'push_cancel', 'reject'),
  ],
  stall: [d('Resume', 'wd_resume', 'approve')],
  jobs_review: [d('Reviewed, pull', 'jobs_pull', 'approve'), d('Skip', 'jobs_skip', 'reject')],
  jobs_fill: [d('Order anyway', 'jobs_order_now', 'approve'), d('Abort', 'jobs_abort', 'reject')],
  jobs_write: [d('Write to gtm', 'jobs_write', 'approve'), d('Discard', 'jobs_discard', 'reject')],
  jobs_stall: [d('Resume', 'jobs_resume', 'approve'), d('Abort', 'jobs_abort', 'reject')],
  lfo_count: [
    ...LFO_PRESETS.map((n): ButtonSpec => ({ label: n.toLocaleString('en-US'), action: 'lfo_count', mode: 'decide', tone: 'approve', count: n })),
    { label: 'Custom…', action: 'lfo_count', mode: 'decide', tone: 'neutral', needsCount: true },
    d('Cancel', 'lfo_cancel', 'reject'),
  ],
  lume_action: [
    { label: 'Confirm', action: 'lume_ok', mode: 'action_decide', tone: 'approve' },
    { label: 'Cancel', action: 'lume_no', mode: 'action_decide', tone: 'reject' },
  ],
}

export const KIND_LABEL: Record<GateKind, string> = {
  ingest_approval: 'CSV approval',
  finder_decision: 'Email finder',
  campaign_choice: 'Pick a campaign',
  push_review: 'Push review',
  stall: 'Stalled job',
  jobs_review: 'Job scrape review',
  jobs_fill: 'Below minimum',
  jobs_write: 'Write contacts',
  jobs_stall: 'Stalled batch',
  lfo_count: 'Leadsfriday count',
  lume_action: 'Needs confirmation',
}

/**
 * The buttons for one gate. `ingest_approval` narrows to what the view
 * offers (Deny only when no email column was detected); every other kind
 * shows its full list.
 */
export function buttonsFor(gate: Pick<GateRow, 'kind' | 'actions'>): readonly ButtonSpec[] {
  const specs = BUTTON_SPECS[gate.kind] ?? []
  if (gate.kind === 'ingest_approval' && gate.actions?.length) {
    const offered = new Set(gate.actions)
    return specs.filter((s) => offered.has(s.action))
  }
  return specs
}

/**
 * Actions that spend money or credits (contacts ordered, enrichment, the
 * email finder; `jobs_pull` resolves companies in Apollo and places a
 * Leadsfriday order). They need a click; no keystroke ever fires them.
 */
export const SPENDING_ACTIONS: ReadonlySet<string> = new Set([
  'jobs_order_now',
  'jobs_pull',
  'approve_enrich',
  'finder_go',
  'lfo_count',
])

const keyboardSafe = (s: ButtonSpec) => s.mode !== 'action_decide' && !SPENDING_ACTIONS.has(s.action)

/**
 * What `A` / `R` press: the first approve-like / reject-like button that is
 * keyboard-safe. Pending-action Confirm/Cancel and spending actions return
 * nothing (click only), so e.g. A on a Leadsfriday count or a below-minimum
 * batch does nothing.
 */
export function hotkeyTarget(specs: readonly ButtonSpec[], which: 'approve' | 'reject'): ButtonSpec | undefined {
  const tone = which === 'reject' ? 'reject' : 'approve'
  return specs.find((s) => s.tone === tone && keyboardSafe(s))
}

export interface GateGroup {
  kind: GateKind
  label: string
  gates: GateRow[]
}

/** Groups in a fixed kind order (the pipeline's order), oldest gate first inside each. */
export function groupByKind(gates: readonly GateRow[]): GateGroup[] {
  const order = Object.keys(BUTTON_SPECS) as GateKind[]
  const by = new Map<GateKind, GateRow[]>()
  for (const g of gates) {
    const list = by.get(g.kind) ?? []
    list.push(g)
    by.set(g.kind, list)
  }
  return order.filter((k) => by.has(k)).map((k) => ({ kind: k, label: KIND_LABEL[k], gates: by.get(k)! }))
}

const COUNT_LABELS: Record<string, string> = {
  row_count: 'rows',
  total_rows: 'rows',
  valid_count: 'valid',
  rows_missing_email: 'no email',
  processed_rows: 'processed',
  companies_added: 'companies',
  companies_pulled: 'companies',
  fill_rounds: 'fill rounds',
  contacts_kept: 'kept',
  contacts_total: 'contacts',
  lookback_days: 'day lookback',
}

/** The numeric `counts` a card shows as chips, in a stable order. */
export function countChips(counts: Record<string, unknown> | null | undefined): { label: string; value: number }[] {
  if (!counts) return []
  return Object.keys(COUNT_LABELS)
    .filter((k) => typeof counts[k] === 'number')
    .map((k) => ({ label: COUNT_LABELS[k], value: counts[k] as number }))
}
