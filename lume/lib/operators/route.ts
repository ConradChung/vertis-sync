import type { GateKind, GateRow, Json, PendingActionKind } from '@/lib/db/types'
import type { Operator, Vertical, VerticalScope } from '@/lib/operators/types'

/**
 * Which vertical (Grok Bot) owns an item that needs a decision: a pending
 * action, a pipeline gate (`lume_gates`), later an alert. Pure.
 *
 * `verticalFor` picks, in order:
 *  1. the live vertical whose `campaign_ids` holds the item's campaign id;
 *  2. else, by scope, but ONLY when exactly one live vertical holds that
 *     scope (a scope several verticals share is ambiguous and says nothing
 *     about the owner);
 *  3. else the default vertical;
 *  4. else null (the owner / master bot only).
 */

export interface RouteItem {
  campaign_id?: string | null
  scope?: VerticalScope | null
}

type RoutableVertical = Pick<Vertical, 'id' | 'name' | 'campaign_ids' | 'scopes' | 'is_default' | 'archived_at'>

const byName = <V extends RoutableVertical>(a: V, b: V) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1)

export function verticalFor<V extends RoutableVertical>(item: RouteItem, verticals: readonly V[]): V | null {
  const live = verticals.filter((v) => !v.archived_at).sort(byName)
  const campaignId = item.campaign_id?.trim()
  if (campaignId) {
    const owner = live.find((v) => v.campaign_ids.includes(campaignId))
    if (owner) return owner
  }
  const scope = item.scope
  if (scope) {
    const scoped = live.filter((v) => v.scopes.includes(scope))
    if (scoped.length === 1) return scoped[0]
  }
  return live.find((v) => v.is_default) ?? null
}

/**
 * What one operator should see: the master bot gets everything (including
 * items no vertical claims); a vertical bot gets the items that route to it.
 */
export function itemsForOperator<T extends RouteItem>(
  op: Pick<Operator, 'is_master' | 'vertical_id'>,
  items: readonly T[],
  verticals: readonly RoutableVertical[]
): T[] {
  if (op.is_master) return [...items]
  if (!op.vertical_id) return []
  return items.filter((item) => verticalFor(item, verticals)?.id === op.vertical_id)
}

// ---------------------------------------------------------------------------
// Pending actions

/** Scope of each pending-action kind; `decide_gate` depends on the gate (see `routeItemForAction`). */
const KIND_SCOPE: Record<PendingActionKind, VerticalScope | null> = {
  push_to_instantly: 'campaign',
  launch_campaign: 'campaign',
  assign_leads: 'campaign',
  activate_rule: 'campaign',
  delete_rule: 'campaign',
  pause_campaign: 'campaign',
  resume_campaign: 'campaign',
  create_campaign: 'campaign',
  update_sequence: 'campaign',
  send_reply: 'replies',
  crm_close_deal: 'replies',
  // An Apify scrape is a paid data order.
  run_actor: 'orders',
  decide_gate: null,
}

export function scopeForPendingKind(kind: string): VerticalScope | null {
  return (KIND_SCOPE as Record<string, VerticalScope | null>)[kind] ?? null
}

/** Scope of a pipeline gate button (a `decide_gate` callback's action). */
export function scopeForGateAction(action: string): VerticalScope | null {
  if (['approve', 'approve_enrich', 'deny', 'wd_resume', 'push_go', 'push_cancel'].includes(action)) return 'validation'
  if (action.startsWith('finder_')) return 'validation'
  if (action.startsWith('jobs_') || action.startsWith('lfo_')) return 'orders'
  if (action === 'camp_launch') return 'campaign'
  return null
}

const str = (v: Json | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** A pending action's routing key: its campaign (payload) and scope (kind, or the gate it decides). */
export function routeItemForAction(a: { kind: string; payload: Record<string, Json> | null }): RouteItem {
  const p = a.payload ?? {}
  const campaign_id = str(p.campaign_id) ?? str(p.source_campaign_id)
  if (a.kind === 'decide_gate') {
    const action = str(p.callback_data)?.split(':')[0] ?? ''
    return { campaign_id, scope: scopeForGateAction(action) }
  }
  return { campaign_id, scope: scopeForPendingKind(a.kind) }
}

// ---------------------------------------------------------------------------
// Gates (view lume_gates)

const GATE_SCOPE: Record<Exclude<GateKind, 'lume_action'>, VerticalScope> = {
  // CSV ingest → validation_jobs: validation and the finder.
  ingest_approval: 'validation',
  finder_decision: 'validation',
  campaign_choice: 'validation',
  push_review: 'validation',
  stall: 'validation',
  // Job-search batches and Apollo → Leadsfriday orders (count choice).
  jobs_review: 'orders',
  jobs_fill: 'orders',
  jobs_write: 'orders',
  jobs_stall: 'orders',
  lfo_count: 'orders',
}

/** The scope a gate kind belongs to; null for `lume_action` (it routes by its action) or an unknown kind. */
export function scopeForGateKind(kind: string): VerticalScope | null {
  return (GATE_SCOPE as Record<string, VerticalScope | undefined>)[kind] ?? null
}

/**
 * A gate's routing key. `push_review` carries its Instantly campaign in
 * `counts.campaign_id`; a `lume_action` gate is a pending action (`title` is
 * its kind, `counts` its payload) and routes like one.
 */
export function scopeForGate(gate: Pick<GateRow, 'kind' | 'title' | 'counts'>): RouteItem {
  if (gate.kind === 'lume_action') return routeItemForAction({ kind: gate.title ?? '', payload: gate.counts ?? {} })
  return { campaign_id: str(gate.counts?.campaign_id), scope: GATE_SCOPE[gate.kind] ?? null }
}
