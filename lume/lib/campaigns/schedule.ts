/**
 * An Instantly campaign's sending window (`campaign_schedule.schedules[0]`),
 * and when it is actually sending: pure, timezone-aware, safe on bad input.
 */
import { OWNER_TZ } from '@/lib/time/owner'

export interface SendSchedule {
  /** IANA zone the window is in (Instantly's own enum, e.g. `Europe/Isle_of_Man`). */
  timezone: string
  /** `HH:MM`, inclusive. */
  from: string
  /** `HH:MM`, exclusive. */
  to: string
  /** Sending weekdays, 0 = Sunday … 6 = Saturday, ascending. */
  days: number[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** `campaign_schedule` → its first schedule, or null when absent or malformed. */
export function parseSchedule(raw: unknown): SendSchedule | null {
  if (!isObj(raw) || !Array.isArray(raw.schedules)) return null
  const s = raw.schedules.find(isObj)
  if (!s || !isObj(s.timing) || typeof s.timezone !== 'string' || !s.timezone) return null
  const from = s.timing.from
  const to = s.timing.to
  if (typeof from !== 'string' || typeof to !== 'string' || !HHMM.test(from) || !HHMM.test(to)) return null
  const days = isObj(s.days)
    ? Object.entries(s.days)
        .filter(([k, v]) => v === true && /^[0-6]$/.test(k))
        .map(([k]) => Number(k))
        .sort((a, b) => a - b)
    : []
  return { timezone: s.timezone, from: pad(from), to: pad(to), days }
}

const pad = (t: string) => t.padStart(5, '0')
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `[1,2,3,4,5]` → "Mon–Fri"; `[0..6]` → "Every day"; gaps → "Mon, Wed, Fri". */
export function formatDays(days: number[]): string {
  if (days.length === 0) return 'No days'
  if (days.length === 7) return 'Every day'
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  if (contiguous && days.length >= 3) return `${DAY[days[0]]}–${DAY[days[days.length - 1]]}`
  return days.map((d) => DAY[d]).join(', ')
}

/** Instantly only accepts some zones, so a few stand in for others (Isle of Man = UK time). */
const ZONE_LABEL: Record<string, string> = {
  'Europe/Isle_of_Man': 'UK',
  'Europe/London': 'UK',
  'America/Chicago': 'Central',
  'America/New_York': 'Eastern',
  'America/Denver': 'Mountain',
  'America/Los_Angeles': 'Pacific',
  'Australia/Melbourne': 'AU East',
  'Australia/Sydney': 'AU East',
}

export function zoneLabel(tz: string): string {
  return ZONE_LABEL[tz] ?? tz.split('/').pop()!.replace(/_/g, ' ')
}

// ---------------------------------------------------------------------------
// Time in an arbitrary zone

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function partsIn(at: Date, tz: string) {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    fmtCache.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: DAY.indexOf(p.weekday) }
}

function offsetMs(at: Date, tz: string): number {
  const p = partsIn(at, tz)
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000
}

/** The instant of wall-clock `minuteOfDay` on y-m-d in `tz` (two passes settle DST). */
function wallTime(tz: string, y: number, m: number, d: number, minuteOfDay: number): Date {
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay)
  let t = guess - offsetMs(new Date(guess), tz)
  t = guess - offsetMs(new Date(t), tz)
  return new Date(t)
}

const hhmm = (at: Date, tz: string) => {
  const p = partsIn(at, tz)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

export interface ScheduleState {
  /** Inside the window right now (ignores the campaign's own status). */
  inWindow: boolean
  /** The window currently open (`inWindow`), else the next one; null when no day is enabled. */
  window: { start: Date; end: Date } | null
  /** That window in the owner's zone, `HH:MM–HH:MM`. */
  ownerWindow: string | null
}

/** Where `now` falls against the schedule. Null when the zone is unknown to this runtime. */
export function scheduleState(s: SendSchedule, now: Date = new Date()): ScheduleState | null {
  try {
    const from = mins(s.from)
    let to = mins(s.to)
    if (to <= from) to += 24 * 60 // overnight window ends the next day
    const today = partsIn(now, s.timezone)
    let window: { start: Date; end: Date } | null = null
    // Yesterday's overnight window may still be open; then today and the next week.
    for (let i = -1; i <= 7 && !window; i++) {
      const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i))
      if (!s.days.includes(day.getUTCDay())) continue
      const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()]
      const start = wallTime(s.timezone, y, m, d, from)
      const end = wallTime(s.timezone, y, m, d, to)
      if (end > now) window = { start, end }
    }
    const inWindow = !!window && window.start <= now
    return { inWindow, window, ownerWindow: window ? `${hhmm(window.start, OWNER_TZ)}–${hhmm(window.end, OWNER_TZ)}` : null }
  } catch {
    return null // RangeError: unknown timezone
  }
}

/** "3h 20m", "45m", "2d 4h". */
export function formatGap(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}
