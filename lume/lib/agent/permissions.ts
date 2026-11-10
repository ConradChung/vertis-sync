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
  open_website: 'read', review_leads: 'read', search_past_chats: 'read',
  search_apify_store: 'read', get_actor_input_schema: 'read', get_actor_run: 'read', list_actor_runs: 'read', rank_campaigns: 'read',
  get_campaign_sequence: 'read', list_skills: 'read', get_skill: 'read', list_verticals: 'read',
  list_campaign_leads: 'read', contact_usage: 'read', get_lead_bank: 'read', read_project_file: 'read', list_replies: 'read', get_thread: 'read', get_sop: 'read',
  list_influencers: 'read', estimate_influencer_run: 'read', get_influencer_run: 'read', read_attachment: 'read', list_influencer_candidates: 'read',
  create_order: 'low', draft_reply: 'low', create_rotation_rule: 'low', notify: 'low', import_actor_run: 'low', save_skill: 'low',
  remember: 'low', forget: 'low', create_vertical: 'low', update_vertical: 'low', create_inbox_project: 'low', create_cycle_out_rule: 'low',
  load_actor_results: 'low', filter_leads: 'low', restore_leads: 'low', export_for_apollo: 'low', label_reply: 'low',
  export_influencer_csv: 'low', add_influencer: 'low', update_influencer: 'low', cancel_influencer_run: 'low', resume_influencer_run: 'low',
  load_attachment_as_leads: 'low', import_influencer_candidates: 'low',
  list_lead_lists: 'read', view_lead_list: 'read', summarize_lead_set: 'read', get_validation_stats: 'read',
  create_lead_list: 'low', append_to_lead_list: 'low', remove_from_lead_list: 'low', rename_lead_list: 'low',
  // Calendar: scheduling spends nothing; a scheduled action is filed for a tap when due (lib/tasks/tick.ts).
  list_tasks: 'read', schedule_task: 'low', update_task: 'low', cancel_task: 'low',
  // Tags: reading progress; retagging an item (its vertical) changes no pipeline state.
  get_progress: 'read', tag_item: 'low',
  decide_validation: 'high', assign_leads: 'high', activate_rule: 'high', send_reply: 'high',
  pause_campaign: 'high', resume_campaign: 'high', activate_campaign: 'high', duplicate_campaign: 'high', delete_rule: 'high',
  run_apify_actor: 'high', update_campaign_sequence: 'high', issue_operator_key: 'high', remove_leads: 'high',
  start_influencer_run: 'high', approve_reactions: 'high', stage_attachment_for_validation: 'high', lookup_influencer_candidates: 'high', approve_influencer_candidates: 'high',
  send_lead_list_to_validation: 'high', delete_lead_list: 'high',
  // New campaign from scratch: suggest first (read), then file it for the owner's tap.
  suggest_campaign_setup: 'read', create_campaign: 'high',
} as const satisfies Record<string, 'read' | 'low' | 'high'>

export type ToolName = keyof typeof TOOL_TIERS

export const HIGH_RISK_KIND: Record<string, PendingKind> = {
  decide_validation: 'decide_gate', assign_leads: 'assign_leads', activate_rule: 'activate_rule', send_reply: 'send_reply',
  pause_campaign: 'pause_campaign', resume_campaign: 'resume_campaign', activate_campaign: 'launch_campaign',
  duplicate_campaign: 'create_campaign', delete_rule: 'delete_rule', run_apify_actor: 'run_actor',
  update_campaign_sequence: 'update_sequence', issue_operator_key: 'issue_operator_key', remove_leads: 'remove_leads',
  start_influencer_run: 'influencer_run', approve_reactions: 'influencer_reactions',
  stage_attachment_for_validation: 'stage_attachment', lookup_influencer_candidates: 'influencer_lookup',
  approve_influencer_candidates: 'influencer_approve',
  send_lead_list_to_validation: 'send_lead_list', delete_lead_list: 'delete_lead_list',
  create_campaign: 'new_campaign',
  // A low-tier tool that files an approval only for a bulk removal (q, missing, or > 25 rows).
  remove_from_lead_list: 'remove_lead_rows',
  // A low-tier tool that files an approval only for a blocking label (unsubscribe, hostile, BAD + block).
  label_reply: 'label_reply',
}

/**
 * Skip-permissions mode is an allowlist: only these kinds are approved and run
 * without a tap. The owner chose that assign_leads and update_sequence run in
 * skip mode even though assigning into a live campaign leads to sends.
 * Launching, resuming, replies and anything that spends money always ask, and
 * any kind added later asks until it is listed here. issue_operator_key is
 * listed (owner decision, Phase G9): the master Grok Bot hands a new bot its
 * sign-in link without waiting; the link is returned once and stored masked.
 * remove_leads is listed (owner decision, Phase 2): deleting leads from a
 * campaign frees the contact cap; the executor always skips replied and
 * interested leads and snapshots every lead it removes.
 */
export const SKIPPABLE_KINDS: ReadonlySet<PendingKind> = new Set<PendingKind>([
  'pause_campaign', 'create_campaign', 'delete_rule', 'activate_rule', 'assign_leads', 'update_sequence', 'issue_operator_key',
  'remove_leads',
])

/**
 * The agent's kinds that still need a tap in skip mode (documentation; the
 * allowlist above decides): they spend money (Apify runs; gate decisions that
 * buy Leadsfriday / finder / validator work; the PM influencer reactions
 * pipeline's two approvals, Apify + Perplexity) or email leads (a reply;
 * launching or resuming a campaign starts sends). stage_attachment puts a
 * chat spreadsheet in front of the validation pipeline (paid once approved);
 * send_lead_list does the same for a lead list; delete_lead_list cannot be undone.
 * new_campaign creates a campaign on the owner's inboxes (owner decision: always a tap).
 */
export const ALWAYS_ASK_KINDS: ReadonlySet<PendingKind> = new Set<PendingKind>([
  'run_actor', 'send_reply', 'decide_gate', 'launch_campaign', 'resume_campaign', 'label_reply', 'influencer_run', 'influencer_reactions',
  'stage_attachment', 'influencer_lookup', 'influencer_approve', 'send_lead_list', 'delete_lead_list', 'remove_lead_rows',
  // A new campaign (with its inboxes and copy) always waits on the owner's tap.
  'new_campaign',
])

export const skippable = (kind: PendingKind): boolean => SKIPPABLE_KINDS.has(kind)
