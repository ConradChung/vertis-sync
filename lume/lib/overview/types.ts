import type { EventRow, Overview, ScheduledJob } from '@/lib/db/types'
import type { InstantlyAccount } from '@/lib/adapters/instantly.map'

/** Shapes of `GET /api/overview` and `GET /api/scheduled-jobs`. */

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
  /** Daily sends over the last 7 UTC days, oldest first. Empty when there is no data. */
  series: number[]
  bounces_24h: number
  health: CampaignHealth
}

export type InstantlySummary =
  | { configured: false }
  | {
      configured: true
      /** Set when Instantly could not be read; the numbers below are then absent. */
      error?: string
      /** Which campaigns were summed: rows of `lume_campaigns`, or Instantly's own list. */
      campaign_source?: 'lume_campaigns' | 'instantly_list'
      sent_today?: number
      sent_7d?: number[]
      opportunities?: number
      /** Only when `lume_campaigns.opportunity_value_usd` is set for a campaign with opportunities. */
      opportunities_value_usd?: number | null
      opportunities_7d?: number[]
      accounts?: InstantlyAccount[]
    }

export interface OverviewPayload extends Overview {
  scheduled_jobs: ScheduledJobWithNext[]
  /** The three soonest active jobs. */
  next_runs: ScheduledJobWithNext[]
  /** Replies per UTC day over the last 7 days (events `type='reply'`), oldest first. */
  replies_7d: number[]
  /** events `type in (reply, interested, bounce)`, newest first. */
  reply_feed: EventRow[]
  /** events `type like 'agent.%' or 'lume.%'`, newest first. */
  agent_activity: EventRow[]
  campaigns: CampaignStripItem[]
  instantly: InstantlySummary
}
