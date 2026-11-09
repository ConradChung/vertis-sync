import { ownerDate } from '@/lib/time/owner'

/**
 * The Calendar screen's date math, pure (browser + prefetch + tests). Dates
 * are owner-zone calendar days as YYYY-MM-DD strings; weeks start Monday.
 */

export interface GridDay {
  date: string
  /** In the month being shown (days padding the first / last week are not). */
  inMonth: boolean
}

const iso = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10)

/** YYYY-MM-DD plus `n` days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return iso(y, m - 1, d + n)
}

/** The first of the month `n` months after the month of `date`. */
export function addMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number)
  return iso(y, m - 1 + n, 1)
}

/** Monday-first weeks covering the month of `date` (4 to 6 rows of 7 days). */
export function monthGrid(date: string): GridDay[][] {
  const [y, m] = date.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const lead = (first.getUTCDay() + 6) % 7 // Monday = 0
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const rows = Math.ceil((lead + daysInMonth) / 7)
  const weeks: GridDay[][] = []
  for (let w = 0; w < rows; w++) {
    const week: GridDay[] = []
    for (let i = 0; i < 7; i++) {
      const day = iso(y, m - 1, 1 - lead + w * 7 + i)
      week.push({ date: day, inMonth: Number(day.slice(5, 7)) === m })
    }
    weeks.push(week)
  }
  return weeks
}

/** The SWR key for a month's grid: every task due from its first to its last shown day. */
export function tasksKeyForMonth(date: string): string {
  const grid = monthGrid(date)
  const last = grid[grid.length - 1][6].date
  return `/api/tasks?from=${grid[0][0].date}&to=${addDays(last, 1)}`
}

/** Today in the owner's zone. */
export const ownerToday = (now: Date = new Date()): string => ownerDate(now)

/** Tasks by owner-zone due date, each day's list in due order. */
export function groupByDay<T extends { due_at: string }>(tasks: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const t of [...tasks].sort((a, b) => a.due_at.localeCompare(b.due_at))) {
    const day = ownerDate(t.due_at)
    const list = out.get(day)
    if (list) list.push(t)
    else out.set(day, [t])
  }
  return out
}

const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

export const monthLabel = (date: string) => monthFmt.format(new Date(`${date.slice(0, 7)}-01T00:00:00Z`))
export const dayLabel = (date: string) => dayFmt.format(new Date(`${date}T00:00:00Z`))
