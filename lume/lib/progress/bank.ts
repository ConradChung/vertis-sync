/** A banked push's standing, as GET /api/jobs/[id]/bank returns it. */
export interface BankStatus {
  queued: number
  in_instantly: number
  done: number
  in_instantly_total: number | null
  cap: number
  last_run_at: string | null
  ahead: number
  next_run_at: string
}

/** The next instantly-rotate run (pg_cron instantly-rotate-am / -pm: 13:00 and 01:00 UTC). */
export function nextRotation(now: Date): string {
  const t = new Date(now)
  for (let i = 0; i < 3; i++) {
    for (const h of [1, 13]) {
      const c = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + i, h, 0, 0))
      if (c > now) return c.toISOString()
    }
  }
  return now.toISOString()
}

