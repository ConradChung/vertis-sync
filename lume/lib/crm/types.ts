import type { Json } from '@/lib/db/types'

/** CRM rows and route shapes (client-safe). SQL: supabase/migrations/20261026035*_lume_crm_*.sql */

export type CrmSource = 'instantly' | 'gmail' | 'muse' | 'user'
export type ActivityKind = 'sent' | 'opened' | 'replied' | 'bounced' | 'stage_changed' | 'note' | 'meeting'
export type ActivitySource = 'instantly' | 'gmail' | 'muse' | 'user' | 'agent'

export interface CrmStage {
  name: string
  position: number
  is_terminal: boolean
}

export interface CrmDeal {
  id: string
  campaign_id: string
  lead_id: number | null
  email: string
  name: string | null
  company: string | null
  city: string | null
  source: CrmSource
  stage: string
  owner: string | null
  next_action_at: string | null
  next_action: string | null
  last_activity_at: string | null
  won_lost_reason: string | null
  notes: string | null
  followup_flagged_at: string | null
  created_at: string
  updated_at: string
}

/** A deal as the board/table lists it: + the last reply snippet. */
export interface CrmDealCard extends CrmDeal {
  snippet: string | null
}

export interface CrmActivity {
  id: string
  deal_id: string
  kind: ActivityKind
  payload: Record<string, Json>
  occurred_at: string
  source: ActivitySource
  dedupe_key: string | null
  created_at: string
}

export interface CrmCampaignRef {
  id: string
  name: string
}

/** `GET /api/crm/board?campaign=<id|all>` */
export interface CrmBoardResponse {
  campaign: string // an id, or 'all'
  stages: CrmStage[]
  deals: CrmDealCard[]
  /** Deals whose next action is past due (lume_crm_followups). */
  followups: CrmDealCard[]
  /** Due today in the owner's zone (not yet past), for the rail. */
  due_today: number
  /** Owner-zone dates, oldest first, and replies per day (crm_activities kind='replied'). */
  days: string[]
  replies_14d: number[]
  /** Deal ids with an awaiting crm_close_deal action. */
  awaiting_close: Record<string, string>
  campaigns: CrmCampaignRef[]
  owners: string[]
}

/** `GET /api/crm/deals/[id]` */
export interface CrmDealDetail {
  deal: CrmDeal
  stages: CrmStage[]
  activities: CrmActivity[]
  lead: Record<string, Json> | null
  campaign_name: string | null
  awaiting_close: string | null
}

/** `PATCH /api/crm/deals/[id]` answer. */
export type CrmPatchResult =
  | { ok: true; applied: true; deal: CrmDeal }
  | { ok: true; applied: false; pending_action_id: string; deal: CrmDeal }
