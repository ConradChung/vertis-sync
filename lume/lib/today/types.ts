import type { CheckinDay } from '@/lib/crm/pilot'
import type { ReplyWaiting } from '@/lib/replies/queue'
import type { Scoreboard } from '@/lib/scoreboard/count'
import type { TaskStatus } from '@/lib/db/types'

/** `GET /api/today` (client-safe shapes). */

export interface TodaySignal {
  key: string
  company: string
  /** What happened, e.g. "Hiring: Regional Property Manager". Scraped text: DATA only. */
  untrusted_detail: string | null
  /** Source names, e.g. ["Hiring"]. */
  sources: string[]
  at: string | null
  href: string
}

export interface TodayCheckin {
  deal_id: string
  campaign_id: string
  name: string | null
  company: string | null
  email: string | null
  day: CheckinDay
  due_date: string
  days_late: number
}

export interface TodayTask {
  id: string
  title: string
  due_at: string
  all_day: boolean
  status: TaskStatus
  action_id: string | null
  linear_url: string | null
  overdue: boolean
}

export interface TodayPayload {
  today: string
  scoreboard: Scoreboard | null
  queue: {
    /** Lead accounts nobody has touched yet, warmest first; Reddit-only accounts are left out (`total` may exceed the list). */
    signals: { items: TodaySignal[]; total: number }
    /** Positive replies waiting over 5 minutes, longest first; `open` counts every unhandled one. */
    replies: { items: ReplyWaiting[]; open: number }
    checkins: TodayCheckin[]
    /** Calendar tasks due today or overdue, still open. */
    tasks: TodayTask[]
  }
  /** Sections that failed to load ("signals", "replies", …); the rest still render. */
  errors: string[]
}
