import type { PendingActionKind } from '@/lib/db/types'

/**
 * The single source of truth for what the orb agent may do on its own.
 *
 *  - read: runs; calls a GET route with the internal bearer
 *  - low:  runs; creates something inert (an order awaiting a count, an
 *          inactive rule, an import waiting at the Approve/Deny ingest
 *          gate), drafts text, or notifies
 *  - high: never runs. It creates a `pending_actions` row (Telegram ping +
 *          `/actions/<id>` deep link) and the owner's tap executes it.
 */
type PendingKind = PendingActionKind
export type ToolTier = 'read' | 'low' | 'high'

export const TOOL_TIERS = {
  list_orders: 'read', get_validation_queue: 'read', list_campaigns: 'read', campaign_stats: 'read',
  list_rules: 'read', list_scheduled_jobs: 'read', inbox_health: 'read',
  search_apify_store: 'read', get_actor_input_schema: 'read', get_actor_run: 'read', rank_campaigns: 'read',
  create_order: 'low', draft_reply: 'low', create_rotation_rule: 'low', notify: 'low', import_actor_run: 'low',
  decide_validation: 'high', assign_leads: 'high', activate_rule: 'high', send_reply: 'high',
  pause_campaign: 'high', resume_campaign: 'high', activate_campaign: 'high', duplicate_campaign: 'high', delete_rule: 'high',
  run_apify_actor: 'high',
} as const satisfies Record<string, 'read' | 'low' | 'high'>

export type ToolName = keyof typeof TOOL_TIERS

export const HIGH_RISK_KIND: Record<string, PendingKind> = {
  decide_validation: 'decide_gate', assign_leads: 'assign_leads', activate_rule: 'activate_rule', send_reply: 'send_reply',
  pause_campaign: 'pause_campaign', resume_campaign: 'resume_campaign', activate_campaign: 'launch_campaign',
  duplicate_campaign: 'create_campaign', delete_rule: 'delete_rule', run_apify_actor: 'run_actor',
}
