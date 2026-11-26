/**
 * Pilot tracking on a deal (pure, client-safe): the start date, the day-10
 * and day-25 check-ins and the referral flag. Dates are owner-zone calendar
 * dates (YYYY-MM-DD); "day 10" is ten days after the start date.
 */

export const CHECKIN_DAYS = [10, 25] as const
export type CheckinDay = (typeof CHECKIN_DAYS)[number]

export interface PilotFields {
  stage: string
  pilot_start_date: string | null
  pilot_checkin_10_done_at: string | null
  pilot_checkin_25_done_at: string | null
  referral_asked_at: string | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const toUtc = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10))

/** A real calendar date in YYYY-MM-DD. */
export function isDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v) && new Date(toUtc(v)).toISOString().slice(0, 10) === v
}

export function addDays(date: string, n: number): string {
  return new Date(toUtc(date) + n * 86_400_000).toISOString().slice(0, 10)
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}

/** Days since the pilot started (0 on the start date), or null without a start date. */
export function pilotDay(start: string | null, today: string): number | null {
  return isDate(start) ? daysBetween(start, today) : null
}

/** `not_done`: unticked on a deal that is no longer in Pilot, so nothing is owed. */
export type CheckinState = 'done' | 'due' | 'upcoming' | 'not_done'

export interface Checkin {
  day: CheckinDay
  due_date: string
  done_at: string | null
  state: CheckinState
  /** Days past the due date (0 on the day); 0 unless `state` is 'due'. */
  days_late: number
}

const doneAt = (d: PilotFields, day: CheckinDay) => (day === 10 ? d.pilot_checkin_10_done_at : d.pilot_checkin_25_done_at)

/**
 * Both check-ins of a deal with a start date; [] without one. A check-in is
 * only ever `due` while the deal is in Pilot: once it leaves (Paid, Lost,
 * back to Demo) an unticked one reads `not_done` and is never late.
 */
export function pilotCheckins(d: PilotFields, today: string): Checkin[] {
  const start = d.pilot_start_date
  if (!isDate(start)) return []
  return CHECKIN_DAYS.map((day) => {
    const due = addDays(start, day)
    const done = doneAt(d, day)
    const late = daysBetween(due, today)
    const state: CheckinState = done ? 'done' : d.stage !== 'Pilot' ? 'not_done' : late >= 0 ? 'due' : 'upcoming'
    return { day, due_date: due, done_at: done, state, days_late: state === 'due' ? late : 0 }
  })
}

export interface CheckinDue<T> {
  deal: T
  day: CheckinDay
  due_date: string
  days_late: number
}

/**
 * Check-ins that need doing now: the deal is in Pilot, the check-in's day has
 * come and it is not ticked. A deal that left Pilot (Paid, Lost, back to
 * Demo) owes none (`pilotCheckins` never reports `due` for it). Most overdue first.
 */
export function checkinsDue<T extends PilotFields>(deals: readonly T[], today: string): CheckinDue<T>[] {
  const out: CheckinDue<T>[] = []
  for (const deal of deals) {
    for (const c of pilotCheckins(deal, today)) {
      if (c.state === 'due') out.push({ deal, day: c.day, due_date: c.due_date, days_late: c.days_late })
    }
  }
  return out.sort((a, b) => b.days_late - a.days_late || a.day - b.day)
}

const shortFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
/** "Nov 30" for a YYYY-MM-DD date. */
export const shortDate = (date: string) => shortFmt.format(new Date(toUtc(date)))
