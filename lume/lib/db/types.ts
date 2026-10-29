/**
 * Row types for what Lume reads and writes in Supabase.
 *
 * Hand-written from the SQL in supabase/migrations/20261014*_lume_*.sql
 * (views: lume_views + lume_views_fixes; tables: lume_core + lume_core_fixes;
 * RPCs: lume_triggers_fixes). Keep them honest to the SQL.
 *
 * TODO(later): regenerate with
 *   supabase gen types typescript --project-id rcfrumrbauwvyzfebxck --schema public > lume/lib/db/database.types.ts
 * and derive these from `Database['public']`. Views and `returns json` RPCs
 * come back loosely typed from the generator, so the view/RPC shapes below
 * would still be the source of truth for the UI.
 */

// ---------------------------------------------------------------------------
// Gates (view lume_gates)

export const GATE_KINDS = [
  'ingest_approval',
  'finder_decision',
  'campaign_choice',
  'push_review',
  'stall',
  'jobs_review',
  'jobs_fill',
  'jobs_write',
  'jobs_stall',
  'lfo_count',
  'lume_action',
] as const
export type GateKind = (typeof GATE_KINDS)[number]

/** Tables `lume_gate_opened()` fires for; `target_table` in the hook body. */
export const GATE_TARGET_TABLES = [
  'telegram_ingests',
  'validation_jobs',
  'job_batches',
  'apollo_orders',
  'pending_actions',
] as const
export type GateTargetTable = (typeof GATE_TARGET_TABLES)[number]

/** Button actions each gate kind offers, exactly as the view's `actions` column. */
export const GATE_ACTIONS: Record<GateKind, readonly string[]> = {
  ingest_approval: ['approve', 'approve_enrich', 'deny'], // ['deny'] alone when no email column was detected
  finder_decision: ['finder_go', 'finder_skip'],
  campaign_choice: ['pick_campaign', 'push_cancel'],
  push_review: ['bar_loc', 'bar_co', 'push_strict', 'push_std', 'push_go', 'push_cancel'],
  stall: ['wd_resume'],
  jobs_review: ['jobs_pull', 'jobs_skip'],
  jobs_fill: ['jobs_order_now', 'jobs_abort'],
  jobs_write: ['jobs_write', 'jobs_discard'],
  jobs_stall: ['jobs_resume', 'jobs_abort'],
  lfo_count: ['lfo_count', 'lfo_cancel'],
  lume_action: ['lume_ok', 'lume_no'],
}

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface GateRow {
  kind: GateKind
  target_table: GateTargetTable
  target_id: string
  title: string | null
  subtitle: string | null
  actions: string[]
  counts: Record<string, Json>
  telegram_message_id: number | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Orders (view lume_orders)

export type OrderKind = 'ingest' | 'apollo_order' | 'job_batch' | 'dashboard_job'

export interface OrderRow {
  kind: OrderKind
  id: string
  source: string | null
  summary: string | null
  row_count: number | null
  status: string | null
  cost_usd: number | null
  created_by: string | null
  validation_job_id: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Lead bank (view lume_lead_bank)

export type LeadBankOrigin = 'lead_bank' | 'validation_rows'

export interface LeadBankRow {
  origin: LeadBankOrigin
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
  city: string | null
  icp_status: string | null
  campaign_id: string | null
  state: string | null // 'queued' for lead_bank rows, 'unassigned' for validation rows
  created_at: string | null
}

// ---------------------------------------------------------------------------
// RPCs

/** One element of `lume_scheduled_jobs()`. */
export interface ScheduledJob {
  name: string
  cron: string
  runner: 'pg_cron' | 'claude' | 'vercel' | 'other' | 'rotation_rule' | string
  active: boolean
  target: string | null
  last_status: string | null
  last_run_at: string | null
}

/** `lume_overview()` result. */
export interface Overview {
  now: string
  pending_gates: number
  replies_today: number
  bounces_24h: number
  active_jobs: number
  lead_bank_queued: number
  /** Open CRM deals whose next action is past due (view lume_crm_followups). Optional: older RPC versions lack it. */
  crm_followups_due?: number
  events_last_at: string | null
  recent_events: EventRow[]
}

// `GET /api/overview`'s full response is `OverviewPayload` in lib/overview/types.ts.

// ---------------------------------------------------------------------------
// Tables

export interface EventRow {
  id: number
  type: string
  source: string | null
  source_id: string | null
  campaign_id: string | null
  lead_email: string | null
  title: string
  payload: Record<string, Json>
  webhook_id: string | null
  created_at: string
}

export type EventInsert = {
  type: string
  source: string
  title: string
  source_id?: string | null
  campaign_id?: string | null
  lead_email?: string | null
  payload?: Record<string, Json>
  webhook_id?: string | null
}

export type PendingActionKind =
  | 'push_to_instantly'
  | 'launch_campaign'
  | 'assign_leads'
  | 'activate_rule'
  | 'send_reply'
  | 'label_reply'
  | 'pause_campaign'
  | 'resume_campaign'
  | 'create_campaign'
  | 'decide_gate'
  | 'delete_rule'
  | 'crm_close_deal'
  | 'run_actor'
  | 'update_sequence'
  | 'issue_operator_key'
  | 'remove_leads'

export type PendingActionStatus =
  | 'awaiting'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'rejected'
  | 'failed'
  | 'expired'

export interface PendingActionRow {
  id: string
  kind: PendingActionKind
  payload: Record<string, Json>
  risk: 'high'
  status: PendingActionStatus
  claim_status: 'awaiting' | 'claimed'
  requested_by: 'user' | 'agent' | 'rule'
  agent_run_id: string | null
  rule_id: string | null
  telegram_message_id: number | null
  decided_via: 'lume' | 'telegram' | 'agent' | 'operator' | 'grant' | 'client' | null
  /** The Grok Bot operator that decided (decided_via 'operator'). */
  decided_by_operator?: string | null
  /** decided_via 'client' (3g): the Slack user and workspace that decided. */
  decided_by_slack_user?: string | null
  decided_by_slack_team?: string | null
  /** 3g: the Slack user whose Edit is the current send_reply body (may not approve it). */
  edited_by_slack_user?: string | null
  decided_at: string | null
  executed_at: string | null
  result: Record<string, Json> | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface AgentRunRow {
  id: string
  prompt: string
  status: 'running' | 'needs_approval' | 'done' | 'failed'
  plan: Json | null
  tool_calls: Json[]
  approval_action_id: string | null
  outcome: string | null
  model: string | null
  usage: Record<string, Json> | null
  created_at: string
  finished_at: string | null
}

export interface RotationRuleFilter {
  source?: string
  icp_status?: string
  city?: string
  since?: string
}

export interface RotationRuleRow {
  id: string
  name: string
  campaign_id: string // soft reference to lume_campaigns.external_id
  filter: RotationRuleFilter
  daily_cap: number
  order_by: 'newest' | 'oldest'
  cron: string
  active: boolean
  next_run_at: string | null
  last_run_at: string | null
  last_result: Record<string, Json> | null
  created_at: string
  /** 'rotate' (lead bank → campaign) or 'cycle_out' (remove finished leads, then refill). */
  kind: RotationRuleKind
  /** cycle_out: `{ after_days, refill_to? }`; rotate: `{}`. */
  params: Record<string, Json>
}

export type RotationRuleKind = 'rotate' | 'cycle_out'

export interface LumeCampaignRow {
  id: string
  family: 'kaspen' | 'recruiter' | 'muse' | 'other'
  name: string
  external_id: string | null
  sender_type: 'instantly' | 'gmail' | 'muse'
  status: string // draft|active|paused|completed|manual|unknown
  capacity_per_day: number | null
  opportunity_value_usd: number | null
  instantly: Record<string, Json> | null
  synced_at: string | null
  created_at: string
}

export interface LumeExternalScheduleRow {
  id: string
  name: string
  cron: string
  target: string
  runner: 'claude' | 'vercel' | 'other'
  last_status: string | null
  last_run_at: string | null
  notes: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Validate screen (validation_jobs / validation_rows reads)

/** `getJobProgress()`: the progress panel inside a job gate. */
export interface JobProgress {
  id: string
  filename: string | null
  status: string | null
  total_rows: number
  processed_rows: number
  eta_seconds: number | null
  eta_updated_at: string | null
  enrich: boolean
  enrich_started: boolean
  enriched_rows: number
  finder_status: string | null
  rows_missing_email: number | null
  emails_found: number | null
  instantly_status: string | null
  instantly_campaign_id: string | null
  instantly_campaign_name: string | null
  location_barrier: boolean
  company_barrier: boolean
  company_strict: boolean
  /** Exact per-status counts over validation_rows. */
  counts: { pending: number; valid: number; invalid: number; error: number; no_email: number }
}

/** `instantly-push` `mode:'preview'` response. */
export interface PushPreview {
  ok: boolean
  eligible: number
  filtered: number
  junk: number
  missingFirstName: number
  blankLocation: number
  samples: { original: string; normalized: string }[]
  strict: boolean
  noLocationRouted?: number
  hasNoLocationCampaign?: boolean
  instantlyKeyPresent: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Import intakes (telegram_ingests / apollo_orders / job_batches)

export interface TelegramIngestRow {
  id: string
  telegram_chat_id: string
  telegram_message_id: number | null
  sender_chat_id: string
  sender_name: string | null
  sender_platform: 'telegram' | 'slack' | 'lume'
  filename: string
  storage_path: string
  row_count: number | null
  detected_email_column: string | null
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'error'
  validation_job_id: string | null
  created_at: string
}

export type TelegramIngestInsert = Pick<
  TelegramIngestRow,
  | 'telegram_chat_id'
  | 'sender_chat_id'
  | 'sender_name'
  | 'sender_platform'
  | 'filename'
  | 'storage_path'
  | 'row_count'
  | 'detected_email_column'
  | 'status'
>

export interface ApolloOrderRow {
  id: string
  apollo_url: string | null
  contact_count: number | null
  status: string
  count_status: string
  leadsfriday_order_id: number | null
  leadsfriday_status: string | null
  credits_deducted: number | null
  new_balance: number | null
  ingest_id: string | null
  telegram_message_id: number | null
  error: string | null
  created_at: string
}

export interface JobBatchRow {
  id: string
  batch_date: string
  status: string
  companies_added: number
  companies_pulled: number
  companies_unresolved: number
  contacts_total: number
  contacts_kept: number
  leadsfriday_order_id: number | null
  leadsfriday_status: string | null
  error: string | null
  created_at: string
}

/** The `validation_jobs` fields an orders detail shows. */
export interface JobSampleSource {
  id: string
  filename: string | null
  status: string | null
  total_rows: number | null
  enrich: boolean | null
  icp_filter: boolean | null
  icp_description: string | null
  column_order: unknown
  rows: { row_index: number; row_data: Record<string, unknown> | null }[]
}
