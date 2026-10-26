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

export type StageId = 'import' | 'validate' | 'enrich' | 'push' | 'send' | 'reply'

export type StageAction =
  | { type: 'link'; href: string; label: string }
  | { type: 'pending'; kind: 'pause_campaign' | 'resume_campaign'; label: string }
  | { type: 'tab'; tab: 'inbox'; label: string }
  | { type: 'disabled'; label: string; reason: string }

export interface FlowStage {
  id: StageId
  label: string
  count: number | null
  /** idle = nothing yet; waiting = a gate is open for you; active = running; done = has output. */
  status: 'idle' | 'waiting' | 'active' | 'done'
  hint: string | null
  action: StageAction
}

export interface FlowCounts {
  imported: number
  validated: number
  enriched: number
  pushed: number
  sent: number | null
  replies: number | null
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
  stages: FlowStage[]
}
