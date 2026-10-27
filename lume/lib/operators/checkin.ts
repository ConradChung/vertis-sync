import type { EventRow, GateRow, Json, PendingActionRow } from '@/lib/db/types'
import type { Vertical } from '@/lib/operators/types'
import { scopeForGate, scopeForGateAction, verticalFor, type RouteOptions } from '@/lib/operators/route'
import { BUTTON_SPECS, KIND_LABEL, LFO_PRESETS, SPENDING_ACTIONS } from '@/lib/validate/actions'

/**
 * The `/operator` check-in page's model (Phase G5). Pure: the page loader
 * (`checkinData.ts`) fetches gates, alerts, actions and verticals and these
 * functions route, order and describe them for a browsing Grok Bot.
 */

// ---------------------------------------------------------------------------
// Money

/** Leadsfriday's price per contact (owner-confirmed): count × $0.003. */
export const LEADSFRIDAY_USD_PER_LEAD = 0.003

/** Exact cost in dollars, computed in tenths of a cent so 1,234 → 3.702 (no float drift). */
export function leadsfridayUsd(count: number): number {
  return Math.round(Math.max(0, Math.floor(count)) * 3) / 1000
}

/** `$1.50`, `$3.702`: cents, or tenths of a cent when the amount has them. */
export function formatUsd(usd: number): string {
  const mills = Math.round(usd * 1000)
  const digits = mills % 10 === 0 ? 2 : 3
  return `$${(mills / 1000).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

const n = (v: number) => v.toLocaleString('en-US')

export function leadsfridayCostText(count: number): string {
  return `${formatUsd(leadsfridayUsd(count))} (Leadsfriday: ${n(count)} × $0.003)`
}

// ---------------------------------------------------------------------------
// Items

export type Priority = 'money' | 'validation' | 'other'
const PRIORITY_ORDER: Record<Priority, number> = { money: 0, validation: 1, other: 2 }

export interface GateButton {
  label: string
  callback_data: string
  tone: 'approve' | 'neutral' | 'reject'
  spends: boolean
}

export type Control =
  /** A pending action: Approve / Deny forms to POST /api/actions/<id>/decide. */
  | { type: 'approve_deny'; action_id: string }
  /** Gate buttons, each a form to POST /api/gates/decide. */
  | { type: 'gate_buttons'; buttons: GateButton[] }
  /** Leadsfriday count: number input + presets (callback `lfo_count:<id>` + count), and Cancel. */
  | { type: 'lfo_count'; target_id: string; presets: readonly number[]; cancel: GateButton }
  /** Campaign for a validated job: name input → POST /api/gates/campaign/<job>; stored candidates as pick buttons. */
  | { type: 'campaign_pick'; job_id: string; candidates: { id: string; name: string }[]; cancel: GateButton }
  /** Push review: "Push these" files a push_to_instantly confirmation; barrier toggles live on /validate. */
  | { type: 'push_review'; job_id: string; validate_link: string; cancel: GateButton }
  /** Decided elsewhere in Lume (e.g. a key that must be shown once). */
  | { type: 'link'; href: string; reason: string }

export interface CheckinItem {
  key: string
  kind: GateRow['kind']
  /** The pending-action kind for `lume_action` items. */
  action_kind: string | null
  vertical_id: string | null
  vertical_name: string | null
  priority: Priority
  what: string
  target: string
  leads: number | null
  cost: string | null
  created_at: string
  control: Control
}

const num = (v: Json | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: Json | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

const btn = (label: string, action: string, targetId: string, tone: GateButton['tone']): GateButton => ({
  label,
  callback_data: `${action}:${targetId}`,
  tone,
  spends: SPENDING_ACTIONS.has(action),
})

const ACTION_LABEL: Record<string, string> = {
  push_to_instantly: 'Push leads to Instantly',
  launch_campaign: 'Launch campaign',
  assign_leads: 'Assign leads to a campaign',
  activate_rule: 'Activate rotation rule',
  delete_rule: 'Delete rotation rule',
  send_reply: 'Send a reply to a lead',
  pause_campaign: 'Pause campaign',
  resume_campaign: 'Resume campaign',
  create_campaign: 'Duplicate campaign',
  update_sequence: 'Edit campaign emails',
  crm_close_deal: 'Close CRM deal',
  run_actor: 'Run Apify actor (spends money)',
  decide_gate: 'Pipeline gate decision',
  issue_operator_key: 'Issue a Grok Bot operator key',
}

function priorityOf(gate: GateRow): Priority {
  switch (gate.kind) {
    case 'lfo_count':
    case 'jobs_fill':
    case 'jobs_review':
    case 'finder_decision':
      return 'money'
    case 'ingest_approval':
    case 'campaign_choice':
    case 'push_review':
    case 'stall':
      return 'validation'
    case 'lume_action': {
      const kind = gate.title ?? ''
      if (kind === 'run_actor') return 'money'
      if (kind === 'decide_gate') {
        const action = str(gate.counts?.callback_data)?.split(':')[0] ?? ''
        if (SPENDING_ACTIONS.has(action)) return 'money'
        return scopeForGate(gate).scope === 'validation' ? 'validation' : 'other'
      }
      if (kind === 'push_to_instantly') return 'validation'
      return 'other'
    }
    default:
      return 'other'
  }
}

function leadsOf(gate: GateRow): number | null {
  const c = gate.counts ?? {}
  switch (gate.kind) {
    case 'ingest_approval':
      return num(c.row_count)
    case 'finder_decision':
    case 'stall':
      return num(c.total_rows)
    case 'campaign_choice':
    case 'push_review':
      return num(c.valid_count)
    case 'jobs_write':
      return num(c.contacts_kept)
    case 'lume_action': {
      const lfo = lfoCountOf(str(c.callback_data))
      return lfo ?? num(c.eligible) ?? num(c.count) ?? num(c.expected_items)
    }
    default:
      return null
  }
}

/** `lfo_count:<id>:<n>` → n. */
function lfoCountOf(callback: string | null): number | null {
  if (!callback) return null
  const [action, , count] = callback.split(':')
  if (action !== 'lfo_count' || !count || !/^\d+$/.test(count)) return null
  return Number(count)
}

function costOf(gate: GateRow, leads: number | null): string | null {
  const c = gate.counts ?? {}
  switch (gate.kind) {
    case 'lfo_count':
      return `Leadsfriday $0.003 per contact, you choose the count (minimum 500 = ${formatUsd(leadsfridayUsd(500))}; ${LFO_PRESETS.map((p) => `${n(p)} = ${formatUsd(leadsfridayUsd(p))}`).join(', ')})`
    case 'jobs_fill':
      return 'Order anyway places a Leadsfriday order at $0.003 per contact (500 minimum = $1.50); the final count is known only after resolving'
    case 'jobs_review':
      return 'Reviewed, pull resolves companies in Apollo and places a Leadsfriday order at $0.003 per contact'
    case 'finder_decision':
      return `Find them first spends email-finder credits on ${n(num(c.rows_missing_email) ?? 0)} rows without an email; Validate only does not`
    case 'ingest_approval':
      return leads !== null ? `Validation of ${n(leads)} rows; Approve + Enrich also spends Apollo enrichment credits` : null
    case 'lume_action': {
      const kind = gate.title ?? ''
      if (kind === 'run_actor') {
        const budget = num(c.budget_usd)
        const est = num(c.estimate_usd)
        const cap = num(c.cap_usd)
        const parts = [
          budget !== null ? `Apify hard cap ${formatUsd(budget)}` : null,
          est !== null ? `estimate ${formatUsd(est)}` : null,
          cap !== null ? `ceiling ${formatUsd(cap)}` : null,
        ].filter(Boolean)
        return parts.length ? parts.join(', ') : 'Apify run (capped)'
      }
      const lfo = lfoCountOf(str(c.callback_data))
      if (lfo !== null) return leadsfridayCostText(lfo)
      return null
    }
    default:
      return null
  }
}

function controlOf(gate: GateRow): Control {
  const id = gate.target_id
  switch (gate.kind) {
    case 'lume_action':
      if (gate.title === 'issue_operator_key') {
        return { type: 'link', href: `/actions/${id}`, reason: 'The new sign-in link is shown once, on the action page' }
      }
      return { type: 'approve_deny', action_id: id }
    case 'lfo_count':
      return { type: 'lfo_count', target_id: id, presets: LFO_PRESETS, cancel: btn('Cancel', 'lfo_cancel', id, 'reject') }
    case 'campaign_choice': {
      const raw = gate.counts?.candidates
      const candidates = Array.isArray(raw)
        ? raw.flatMap((x) => {
            if (!x || typeof x !== 'object' || Array.isArray(x)) return []
            const cid = str((x as Record<string, Json>).id)
            const name = str((x as Record<string, Json>).name)
            return cid && name ? [{ id: cid, name }] : []
          })
        : []
      return { type: 'campaign_pick', job_id: id, candidates, cancel: btn('Cancel push', 'push_cancel', id, 'reject') }
    }
    case 'push_review':
      return {
        type: 'push_review',
        job_id: id,
        validate_link: `/validate?gate=push_review:${id}`,
        cancel: btn('Cancel push', 'push_cancel', id, 'reject'),
      }
    default: {
      const specs = BUTTON_SPECS[gate.kind] ?? []
      const offered = gate.kind === 'ingest_approval' && gate.actions?.length ? new Set(gate.actions) : null
      const buttons = specs
        .filter((s) => s.mode === 'decide' && !s.needsCount && s.count === undefined && (!offered || offered.has(s.action)))
        .map((s) => btn(s.label, s.action, id, s.tone))
      return { type: 'gate_buttons', buttons }
    }
  }
}

export function describeGate(gate: GateRow, verticals: readonly Vertical[], opts: RouteOptions = {}): CheckinItem {
  const vertical = verticalFor(scopeForGate(gate), verticals, opts)
  const leads = leadsOf(gate)
  const isAction = gate.kind === 'lume_action'
  const actionKind = isAction ? (gate.title ?? '') : null
  const what = isAction ? (ACTION_LABEL[actionKind ?? ''] ?? actionKind ?? 'Pending action') : KIND_LABEL[gate.kind]
  const target = isAction
    ? (gate.subtitle ?? actionKind ?? '')
    : [gate.title, gate.subtitle].filter(Boolean).join(' — ')
  return {
    key: `${gate.kind}:${gate.target_id}`,
    kind: gate.kind,
    action_kind: actionKind,
    vertical_id: vertical?.id ?? null,
    vertical_name: vertical?.name ?? null,
    priority: priorityOf(gate),
    what,
    target,
    leads,
    cost: costOf(gate, leads),
    created_at: gate.created_at,
    control: controlOf(gate),
  }
}

/** Money first, then validation, then the rest; oldest first inside each. */
export function orderItems(items: readonly CheckinItem[]): CheckinItem[] {
  return [...items].sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
  )
}

/** Which vertical(s) a check-in covers: one vertical, or all of them (the master bot, or the owner without `?vertical=`). */
export type CheckinScope = { all: true } | { all: false; vertical: Vertical }

export function inScope(verticalId: string | null, scope: CheckinScope): boolean {
  return scope.all || verticalId === scope.vertical.id
}

export function needsConfirmation(
  gates: readonly GateRow[],
  verticals: readonly Vertical[],
  scope: CheckinScope,
  opts: RouteOptions = {}
): CheckinItem[] {
  return orderItems(gates.map((g) => describeGate(g, verticals, opts)).filter((i) => inScope(i.vertical_id, scope)))
}

/** Items grouped by vertical, verticals by name, the unrouted (owner-only) group last. */
export function groupByVertical<T extends { vertical_id: string | null; vertical_name: string | null }>(
  items: readonly T[]
): { vertical_id: string | null; vertical_name: string; items: T[] }[] {
  const map = new Map<string, { vertical_id: string | null; vertical_name: string; items: T[] }>()
  for (const it of items) {
    const k = it.vertical_id ?? ''
    const g = map.get(k) ?? { vertical_id: it.vertical_id, vertical_name: it.vertical_name ?? 'No vertical (owner)', items: [] }
    g.items.push(it)
    map.set(k, g)
  }
  return [...map.values()].sort((a, b) =>
    !a.vertical_id ? 1 : !b.vertical_id ? -1 : a.vertical_name.localeCompare(b.vertical_name)
  )
}

// ---------------------------------------------------------------------------
// Alerts

export interface AlertLike {
  id: string
  severity: 'info' | 'warn' | 'urgent'
  campaign_id: string | null
  scope: Vertical['scopes'][number] | null
  created_at: string
  /** Owner / master only (lume_alerts.owner_only). */
  owner_only?: boolean
}

/** Unacked alerts for the scope: urgent first, newest first inside each severity band. */
export function alertsForScope<A extends AlertLike>(
  alerts: readonly A[],
  verticals: readonly Vertical[],
  scope: CheckinScope,
  opts: RouteOptions = {}
): A[] {
  const mine = scope.all ? [...alerts] : alerts.filter((a) => verticalFor(a, verticals, opts)?.id === scope.vertical.id)
  return mine.sort(
    (a, b) =>
      Number(b.severity === 'urgent') - Number(a.severity === 'urgent') ||
      (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)
  )
}

// ---------------------------------------------------------------------------
// Recent outcomes

export interface OutcomeItem {
  id: string
  kind: string
  summary: string
  status: PendingActionRow['status']
  decided_via: PendingActionRow['decided_via']
  decided_by_operator: string | null
  decided_at: string | null
  executed_at: string | null
  error: string | null
  vertical_id: string | null
}

export function outcomesForScope(
  rows: readonly PendingActionRow[],
  verticals: readonly Vertical[],
  scope: CheckinScope,
  routeOf: (a: PendingActionRow) => { campaign_id?: string | null; scope?: Vertical['scopes'][number] | null; owner_only?: boolean },
  opts: RouteOptions = {}
): OutcomeItem[] {
  return rows
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      summary: str(a.payload?.summary) ?? a.kind,
      status: a.status,
      decided_via: a.decided_via,
      decided_by_operator: a.decided_by_operator ?? null,
      decided_at: a.decided_at,
      executed_at: a.executed_at,
      error: a.error,
      vertical_id: verticalFor(routeOf(a), verticals, opts)?.id ?? null,
    }))
    .filter((o) => inScope(o.vertical_id, scope))
}

/** Event types shown under Recent outcomes next to pending actions. */
export const DECISION_EVENT_TYPES = ['lume.decision', 'lume.campaign_pick'] as const

export interface DecisionEventItem {
  id: number
  /** The gate action (`deny`, `lfo_count`, …) or `campaign_pick`. */
  kind: string
  summary: string
  /** `done`, or why it did not apply. */
  status: string
  ok: boolean
  by_operator: string | null
  at: string
  vertical_id: string | null
}

/**
 * Gate decisions (`lume.decision`: Lume clicks and Grok Bot forms) and
 * campaign picks (`lume.campaign_pick`), routed like the gate they decided.
 * A decision whose claim was lost (`claimed: false`, someone else decided
 * first) is marked not applied. Newest first.
 */
export function decisionEventsForScope(
  events: readonly EventRow[],
  verticals: readonly Vertical[],
  scope: CheckinScope,
  opts: RouteOptions = {}
): DecisionEventItem[] {
  const out: DecisionEventItem[] = []
  for (const e of events) {
    const p = e.payload ?? {}
    const operator = str(p.operator_id)
    if (e.type === 'lume.decision') {
      const action = str(p.action) ?? 'decision'
      const lost = p.claimed === false
      const vertical = verticalFor({ campaign_id: e.campaign_id, scope: scopeForGateAction(action) }, verticals, opts)
      out.push({
        id: e.id, kind: action, summary: e.title, status: lost ? 'not applied: already handled elsewhere' : 'done', ok: !lost,
        by_operator: operator, at: e.created_at, vertical_id: vertical?.id ?? null,
      })
    } else if (e.type === 'lume.campaign_pick') {
      const vertical = verticalFor({ campaign_id: e.campaign_id ?? str(p.campaign_id), scope: 'validation' }, verticals, opts)
      out.push({
        id: e.id, kind: 'campaign_pick', summary: e.title, status: 'done', ok: true,
        by_operator: operator, at: e.created_at, vertical_id: vertical?.id ?? null,
      })
    }
  }
  return out.filter((o) => inScope(o.vertical_id, scope)).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

// ---------------------------------------------------------------------------
// Summary

export interface CheckinSummary {
  vertical: { id: string; name: string } | 'all'
  needs_confirmation: number
  unacked_alerts: number
  urgent_alerts: number
  last_checked_at: string | null
  generated_at: string
}

export function checkinSummary(args: {
  scope: CheckinScope
  items: readonly CheckinItem[]
  alerts: readonly AlertLike[]
  lastCheckedAt: string | null
  now: Date
}): CheckinSummary {
  return {
    vertical: args.scope.all ? 'all' : { id: args.scope.vertical.id, name: args.scope.vertical.name },
    needs_confirmation: args.items.length,
    unacked_alerts: args.alerts.length,
    urgent_alerts: args.alerts.filter((a) => a.severity === 'urgent').length,
    last_checked_at: args.lastCheckedAt,
    generated_at: args.now.toISOString(),
  }
}

/** UTC calendar dates for the campaign stats: today, and the 7 days ending today. */
export function statsRanges(now: Date): { today: { startDate: string; endDate: string }; week: { startDate: string; endDate: string } } {
  const day = (d: Date) => d.toISOString().slice(0, 10)
  const today = day(now)
  const weekStart = day(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000))
  return { today: { startDate: today, endDate: today }, week: { startDate: weekStart, endDate: today } }
}

/** Instantly campaign ids among a vertical's campaign_ids (Gmail / Muse ids like `gmail:recruiter` are not). */
export function instantlyCampaignIds(ids: readonly string[]): string[] {
  return ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
}
