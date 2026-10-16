import type { EventRow, Overview, ScheduledJob } from '@/lib/db/types'
import type { InstantlyAccount } from '@/lib/adapters/instantly.map'

/**
 * Shapes of the Overview routes:
 *  - `GET /api/overview` → `OverviewPayload` (database only; refetched on
 *    Realtime inserts the page shows)
 *  - `GET /api/overview/instantly` → `OverviewInstantly` (Instantly KPIs,
 *    accounts and the campaign strip; polled every 60 s, never Realtime-driven)
 *  - `GET /api/scheduled-jobs` → `ScheduledJobWithNext[]`
 */

export type HealthLevel = 'green' | 'amber' | 'red' | 'idle'

export interface CampaignHealth {
  level: HealthLevel
  reason: string
}

export interface ScheduledJobWithNext extends ScheduledJob {
  /** ISO, UTC; `null` when the cron expression does not parse. */
  next_run: string | null
}

export interface CampaignStripItem {
  /** Instantly campaign id, or the `lume_campaigns.external_id` for Gmail/Muse. */
  id: string
  name: string
  sender: 'instantly' | 'gmail' | 'muse'
  status: string
  /** Percent, lifetime (Instantly analytics overview); `null` = no sends / no data. */
  reply_rate: number | null
  sent: number | null
  replies: number | null
  /** Daily sends over the last 7 days (Instantly's days), oldest first. Empty when there is no data. */
  series: number[]
  bounces_24h: number
  health: CampaignHealth
}

export interface OverviewPayload extends Overview {
  scheduled_jobs: ScheduledJobWithNext[]
  /** The three soonest active jobs. */
  next_runs: ScheduledJobWithNext[]
  /** Owner-zone (America/Los_Angeles) dates the 7-day series below are bucketed on, oldest first. */
  days: string[]
  /** Replies per owner-zone day (events `type='reply'`); the last bucket equals `replies_today`. */
  replies_7d: number[]
  /** Gates opened per owner-zone day: `lume.gate_ping` events (one per `lume_gate_opened()` hook call). */
  gates_opened_7d: number[]
  /** events `type in (reply, interested, bounce)`, newest first. */
  reply_feed: EventRow[]
  /** events `type like 'agent.%' or 'lume.%'`, newest first. */
  agent_activity: EventRow[]
}

export type OverviewInstantly =
  | {
      configured: false
      /** Gmail/Muse rows of `lume_campaigns`, plus registered Instantly rows shown idle. */
      campaigns: CampaignStripItem[]
    }
  | {
      configured: true
      /** Set when the workspace-level analytics could not be read; the KPI numbers are then absent. */
      error?: string
      /** Which campaigns the strip lists: rows of `lume_campaigns`, or Instantly's own list. */
      campaign_source: 'lume_campaigns' | 'instantly_list'
      /** Workspace-wide, Instantly's current day (its workspace timezone). */
      sent_today?: number
      sent_7d?: number[]
      /** Workspace-wide lifetime `total_opportunities` (Instantly has no "open" count). */
      opportunities?: number
      /** Only when `lume_campaigns.opportunity_value_usd` is set for a campaign with opportunities. */
      opportunities_value_usd?: number | null
      opportunities_7d?: number[]
      /** Present whenever `/accounts` loaded, even if analytics failed. */
      accounts?: InstantlyAccount[]
      campaigns: CampaignStripItem[]
    }
