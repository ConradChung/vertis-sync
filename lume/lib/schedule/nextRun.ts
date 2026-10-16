import { CronExpressionParser } from 'cron-parser'

/**
 * Next occurrence of a 5-field cron expression, evaluated in UTC (pg_cron
 * and Vercel cron both run in UTC). Strictly after `now`. `null` when the
 * expression is empty or does not parse, so one bad row never breaks a list.
 */
export function nextRun(cron: string | null | undefined, now: Date = new Date()): string | null {
  if (!cron || !cron.trim()) return null
  try {
    const it = CronExpressionParser.parse(cron.trim(), { currentDate: now, tz: 'UTC' })
    return it.next().toISOString()
  } catch {
    return null
  }
}

export type WithNextRun<T> = T & { next_run: string | null }

export function withNextRun<T extends { cron: string | null }>(jobs: T[], now: Date = new Date()): WithNextRun<T>[] {
  return jobs.map((j) => ({ ...j, next_run: nextRun(j.cron, now) }))
}

/** The `n` soonest active jobs that have a next run. */
export function upcoming<T extends { active: boolean; next_run: string | null }>(jobs: T[], n: number): T[] {
  return jobs
    .filter((j) => j.active && j.next_run)
    .sort((a, b) => Date.parse(a.next_run!) - Date.parse(b.next_run!))
    .slice(0, n)
}
