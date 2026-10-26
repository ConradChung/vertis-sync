import type { AnalyticsOverview, DailyPoint, InboxThread, StepPoint } from '@/lib/adapters/instantly.map'
import type { GateRow, LumeCampaignRow } from '@/lib/db/types'

/** Response shapes of the Campaigns routes (Task 13). Client-safe. */

export type InstantlyState = 'ok' | 'not_configured' | 'error'

export interface CampaignTableRow {
  /** Stable row key: the Instantly id, else `lume:<uuid>`. */
  key: string
  /** Instantly campaign id when the campaign lives in Instantly. */
  instantly_id: string | null
  lume_id: string | null
  name: string
  family: LumeCampaignRow['family']
  sender_type: LumeCampaignRow['sender_type']
  status: string
  sent: number | null
  replies: number | null
  /** Percent, null when nothing sent / unknown. */
  reply_rate: number | null
  opportunities: number | null
  bounced: number | null
  last_activity: string | null
}

/** `GET /api/campaigns?with=analytics` */
export interface CampaignTableResponse {
  campaigns: CampaignTableRow[]
  instantly: InstantlyState
}

/** `GET /api/campaigns/[id]/analytics` */
export type CampaignAnalyticsResponse =
  | { configured: false }
  | { configured: true; campaign_id: string; days: number; overview: AnalyticsOverview; daily: DailyPoint[]; steps: StepPoint[] }

/** `GET /api/campaigns/[id]/inbox` */
export type CampaignInboxResponse = { configured: false } | { configured: true; campaign_id: string; threads: InboxThread[] }

export interface CampaignJob {
  id: string
  filename: string | null
  status: string | null
  instantly_status: string | null
  total_rows: number | null
  valid_count: number | null
  enrich: boolean | null
  enriched_rows: number | null
  instantly_pushed: number | null
  created_at: string
}

export type StageId = 'import' | 'validate' | 'enrich' | 'push' | 'send' | 'reply' | 'bank'

export type StageAction =
  | { type: 'link'; href: string; label: string }
  | { type: 'pending'; kind: 'pause_campaign' | 'resume_campaign'; label: string }
  | { type: 'tab'; tab: 'inbox'; label: string }
  | { type: 'disabled'; label: string; reason: string }

export interface FlowStage {
  id: StageId
  label: string
  count: number | null
  /**
   * done = completed or passed (lit); active = running now (the current stage);
   * waiting = a gate is open for you (current); idle = not reached yet;
   * unused = this path does not feed the campaign.
   */
  status: 'idle' | 'waiting' | 'active' | 'done' | 'unused'
  hint: string | null
  /** Where the number comes from (info tooltip). */
  source: string
  action: StageAction
}

export interface FlowCounts {
  /** validation_jobs linked to the campaign: rows, valid, enriched, pushed. */
  imported: number
  validated: number
  enriched: number
  pushed: number
  /** Instantly analytics: emails sent (every step) and replies. */
  sent: number | null
  replies: number | null
  /** lead_bank rows for the campaign, and those still queued. */
  bank_total: number
  bank_queued: number
  /** Leads the rotation pushed into Instantly (sum of rotation_runs.pushed). */
  rotated: number
  /** Leads in the Instantly campaign after the latest rotation, when known. */
  in_campaign: number | null
}

/** Something that feeds leads into the campaign on a schedule (the Flow's forked branch). */
export interface FlowFeeder {
  id: string
  /** rule = a Lume rotation rule; system = the instantly-rotate pg_cron jobs. */
  kind: 'rule' | 'system'
  name: string
  /** Plain English, owner time zone. */
  schedule: string
  cron: string[]
  active: boolean
  next_run: string | null
  last_run: string | null
  last_result: string
  /** Leads added: the rule's last batch, or the rotation's lifetime total. */
  leads_added: number | null
  leads_added_label: string
  href: string
}

export interface LeadSources {
  bank: Record<string, number>
  runs: {
    count: number
    pushed: number
    first_at: string | null
    last: {
      ran_at: string
      pushed: number | null
      deleted: number | null
      archived: number | null
      in_instantly_after: number | null
      note: string | null
      errors: number
    } | null
  } | null
  crons: { name: string; schedule: string; active: boolean }[]
}

/** `GET /api/campaigns/[id]/flow` */
export interface CampaignFlowResponse {
  campaign_id: string
  instantly: InstantlyState
  /** Instantly status label (active / paused / draft / …), null when unknown. */
  campaign_status: string | null
  campaign_name: string | null
  counts: FlowCounts
  jobs: CampaignJob[]
  gates: GateRow[]
  /** Main path: Import → Validate → Enrich → Push → Send → Reply. */
  stages: FlowStage[]
  /** Branch: the campaign's lead bank, fed into Send by the feeders. */
  bank: FlowStage
  feeders: FlowFeeder[]
}
