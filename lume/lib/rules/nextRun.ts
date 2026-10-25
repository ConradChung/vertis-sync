import { CronExpressionParser } from 'cron-parser'
import { OWNER_TZ } from '@/lib/time/owner'

/**
 * Rotation-rule schedules. Unlike `lib/schedule/nextRun` (pg_cron and Vercel
 * cron, both UTC), a rule's cron is written in the owner's wall clock:
 * `0 8 * * 1-5` means 08:00 in Los Angeles on weekdays, across DST.
 * `rotation_rules` has no tz column, so every rule uses `OWNER_TZ`; the `tz`
 * parameter exists for tests and for a future per-rule zone.
 *
 * The rotation tick runs every 15 minutes, so a rule may not fire more often
 * than that — a tighter schedule would only queue duplicate confirmations.
 */

export const RULE_MIN_INTERVAL_MINUTES = 15

/** Next occurrence strictly after `now`, ISO UTC; `null` when empty or unparseable. */
export function nextRun(cron: string | null | undefined, now: Date = new Date(), tz: string = OWNER_TZ): string | null {
  if (!cron || !cron.trim()) return null
  try {
    return CronExpressionParser.parse(cron.trim(), { currentDate: now, tz }).next().toISOString()
  } catch {
    return null
  }
}

/** Five fields, parses, and no two of the next 12 runs are closer than 15 minutes. */
export function isValidRuleCron(cron: string, tz: string = OWNER_TZ): boolean {
  const expr = cron.trim()
  if (expr.split(/\s+/).length !== 5) return false
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: new Date('2026-01-05T00:00:00Z'), tz })
    let prev = it.next().getTime()
    for (let i = 0; i < 12; i++) {
      const cur = it.next().getTime()
      if (cur - prev < RULE_MIN_INTERVAL_MINUTES * 60_000) return false
      prev = cur
    }
    return true
  } catch {
    return false
  }
}

/** `0 8 * * 1-5 (America/Los_Angeles)` — the zone is always shown next to the expression. */
export function describeCron(cron: string, tz: string = OWNER_TZ): string {
  return `${cron.trim()} (${tz})`
}
