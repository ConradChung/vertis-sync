'use client'

import { useEffect, useState } from 'react'
import { AnimatedNumber } from '@/components/ui/animated-number'
import { liveEta } from '@/lib/validate/eta'
import { ValidationBreakdown } from '@/components/validate/ValidationBreakdown'
import type { JobProgress as Job } from '@/lib/db/types'
import { cn } from '@/lib/utils'

const COUNT_TONES: { key: keyof Job['counts']; label: string; tone: string }[] = [
  { key: 'valid', label: 'valid', tone: 'text-green' },
  { key: 'invalid', label: 'invalid', tone: 'text-red' },
  { key: 'error', label: 'error', tone: 'text-amber' },
  { key: 'no_email', label: 'no email', tone: 'text-fg-46' },
  { key: 'pending', label: 'pending', tone: 'text-cyan' },
]

export function Bar({ value, total, label, tone = 'bg-primary' }: { value: number; total: number; label: string; tone?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  // Grow in from 0 on mount (CSS transition; instant under reduced motion).
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(r)
  }, [])
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-fg-70">{label}</span>
        <span className="font-mono text-fg tabular-nums">
          <AnimatedNumber value={value} /> / <AnimatedNumber value={total} />{' '}
          <span className="text-fg-46">
            · <AnimatedNumber value={pct} suffix="%" />
          </span>
        </span>
      </div>
      <div
        className="h-[5px] overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
      >
        <i
          className={cn('block h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none', tone)}
          style={{ width: `${shown ? pct : 0}%` }}
        />
      </div>
    </div>
  )
}

/** Re-render every `ms` so the ETA counts down between polls. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** Email verification for one validation job: verified bar, invalid rate by reason, verdict counts, status and ETA (Progress → Validate step). */
export function JobProgressView({ job, reasons }: { job: Job; reasons?: Job['reasons'] }) {
  const now = useNow(15_000)
  const eta = liveEta(job, now)
  // The bar counts verdicts on validation_rows (exact); the job's own
  // processed_rows / total_rows counter can lag or drift (live: 43/162 on a
  // completed job with 165 rows, 0 pending), so it is shown as a second line.
  const rowsTotal = COUNT_TONES.reduce((n, c) => n + job.counts[c.key], 0)
  const verified = rowsTotal - job.counts.pending
  return (
    <div className="flex flex-col gap-4">
      {rowsTotal > 0 ? (
        <Bar value={verified} total={rowsTotal} label="Verified" />
      ) : (
        <Bar value={job.processed_rows} total={job.total_rows} label="Verified" />
      )}
      {(reasons ?? job.reasons ?? []).length > 0 && <ValidationBreakdown reasons={reasons ?? job.reasons ?? []} />}
      <ul className="grid grid-cols-5 gap-2" aria-label="Row verdicts">
        {COUNT_TONES.map((c) => (
          <li key={c.key} className="rounded-lg bg-white/[0.05] px-2.5 py-2">
            <AnimatedNumber value={job.counts[c.key]} className={cn('block font-mono text-[15px]', c.tone)} />
            <div className="text-[10px] text-fg-46">{c.label}</div>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
        <dt className="text-fg-46">Status</dt>
        <dd className="text-right font-mono text-fg-70">{job.status ?? '—'}</dd>
        <dt className="text-fg-46">Job counter</dt>
        <dd className="text-right font-mono text-fg-70 tabular-nums">
          <AnimatedNumber value={job.processed_rows} /> / <AnimatedNumber value={job.total_rows} /> processed
        </dd>
        {eta && (
          <>
            <dt className="text-fg-46">ETA</dt>
            <dd className="text-right font-mono text-fg-70">{eta}</dd>
          </>
        )}
        {job.rows_missing_email != null && job.rows_missing_email > 0 && (
          <>
            <dt className="text-fg-46">Email finder</dt>
            <dd className="text-right font-mono text-fg-70">
              <AnimatedNumber value={job.emails_found ?? 0} /> found of <AnimatedNumber value={job.rows_missing_email} /> missing
            </dd>
          </>
        )}
      </dl>
    </div>
  )
}
