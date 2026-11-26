import { addDays, shortDate } from '@/lib/crm/pilot'
import { ownerDate, ownerDayStart } from '@/lib/time/owner'

/**
 * The scoreboard's week (pure): Monday 00:00 to the next Monday 00:00 in the
 * owner's zone, so "this week" matches "today" on every other Lume screen.
 */
export interface Week {
  /** Monday, YYYY-MM-DD (owner zone). */
  start: string
  /** The next Monday (exclusive). */
  end: string
  start_iso: string
  end_iso: string
  /** "Nov 23 – Nov 29". */
  label: string
}

export function weekOf(now: Date | string | number = new Date()): Week {
  const today = ownerDate(now)
  // 0 = Sunday … 6 = Saturday, for the calendar date itself.
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay()
  const start = addDays(today, -((dow + 6) % 7))
  const end = addDays(start, 7)
  return {
    start,
    end,
    start_iso: ownerDayStart(start).toISOString(),
    end_iso: ownerDayStart(end).toISOString(),
    label: `${shortDate(start)} – ${shortDate(addDays(end, -1))}`,
  }
}
