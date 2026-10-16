/**
 * The owner's timezone. "Today" on every Lume screen means today here, the
 * same day boundary `lume_overview()` uses for `replies_today`
 * (`date_trunc('day', now() at time zone 'America/Los_Angeles')`).
 */
export const OWNER_TZ = 'America/Los_Angeles'

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: OWNER_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: OWNER_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** Calendar date (YYYY-MM-DD) of an instant in the owner's zone. */
export function ownerDate(at: Date | string | number): string {
  return dateFmt.format(new Date(at))
}

/** Offset of the owner's zone from UTC at `at`, in ms (LA: −7 h or −8 h). */
function offsetMs(at: Date): number {
  const p = Object.fromEntries(partsFmt.formatToParts(at).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The UTC instant of local midnight starting `date` (YYYY-MM-DD) in the owner's zone. */
export function ownerDayStart(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  // Two passes settle the offset across a DST change.
  let t = guess - offsetMs(new Date(guess))
  t = guess - offsetMs(new Date(t))
  return new Date(t)
}

/** The last `n` owner-zone dates ending today, ascending. */
export function lastNOwnerDates(now: Date, n: number): string[] {
  const today = ownerDate(now)
  const [y, m, d] = today.split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10))
  return out
}
