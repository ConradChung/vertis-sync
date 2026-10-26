'use client'

import { GlassCard } from '@/components/ui/glass-card'
import { SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { useJobProgress } from '@/hooks/useJob'
import { formatEta } from '@/lib/validate/client'
import type { JobProgress as Job } from '@/lib/db/types'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

const COUNT_TONES: { key: keyof Job['counts']; label: string; tone: string }[] = [
  { key: 'valid', label: 'valid', tone: 'text-green' },
  { key: 'invalid', label: 'invalid', tone: 'text-red' },
  { key: 'error', label: 'error', tone: 'text-amber' },
  { key: 'no_email', label: 'no email', tone: 'text-fg-46' },
  { key: 'pending', label: 'pending', tone: 'text-cyan' },
]

function Bar({ value, total, label, tone = 'bg-primary' }: { value: number; total: number; label: string; tone?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-fg-70">{label}</span>
        <span className="font-mono text-fg tabular-nums">
          {fmt.format(value)} / {fmt.format(total)} <span className="text-fg-46">· {pct}%</span>
        </span>
      </div>
      <div
        className="h-[5px] overflow-hidden rounded-[3px] bg-white/10"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
      >
        <i className={cn('block h-full rounded-[3px] transition-[width] duration-300', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Email verification progress for a validation job (the "progress panel inside a job row"). */
export function JobProgressView({ job }: { job: Job }) {
  const eta = job.status === 'processing' || job.status === 'pending' ? formatEta(job.eta_seconds) : null
  const validCount = job.counts.valid
  // The bar counts verdicts on validation_rows (exact); the job's own
  // processed_rows / total_rows counter can lag or drift (live: 43/162 on a
  // completed job with 165 rows, 0 pending), so it is shown as a second line.
  const rowsTotal = COUNT_TONES.reduce((n, c) => n + job.counts[c.key], 0)
  const verified = rowsTotal - job.counts.pending
  return (
    <div className="flex flex-col gap-4 px-[18px] pb-[18px]">
      {rowsTotal > 0 ? (
        <Bar value={verified} total={rowsTotal} label="Verified" />
      ) : (
        <Bar value={job.processed_rows} total={job.total_rows} label="Verified" />
      )}
      <ul className="grid grid-cols-5 gap-2" aria-label="Row verdicts">
        {COUNT_TONES.map((c) => (
          <li key={c.key} className="rounded-[9px] border border-white/8 bg-black/15 px-2.5 py-2">
            <div className={cn('font-mono text-[15px] tabular-nums', c.tone)}>{fmt.format(job.counts[c.key])}</div>
            <div className="text-[10px] text-fg-46">{c.label}</div>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
        <dt className="text-fg-46">Status</dt>
        <dd className="text-right font-mono text-fg-70">{job.status ?? '—'}</dd>
        <dt className="text-fg-46">Job counter</dt>
        <dd className="text-right font-mono text-fg-70 tabular-nums">
          {fmt.format(job.processed_rows)} / {fmt.format(job.total_rows)} processed
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
              {fmt.format(job.emails_found ?? 0)} found of {fmt.format(job.rows_missing_email)} missing
            </dd>
          </>
        )}
        {job.instantly_campaign_name && (
          <>
            <dt className="text-fg-46">Campaign</dt>
            <dd className="truncate text-right text-fg-70">{job.instantly_campaign_name}</dd>
          </>
        )}
      </dl>
      {job.enrich && <Bar value={job.enriched_rows} total={validCount} label={job.enrich_started ? 'Enriched (of valid)' : 'Enrich queued'} tone="bg-cyan" />}
    </div>
  )
}

export function JobProgress({ jobId }: { jobId: string }) {
  const { data, error, mutate } = useJobProgress(jobId)
  return (
    <GlassCard className="gap-0 py-0" aria-label="Job progress">
      <SectionTitle title={data?.filename ?? 'Job progress'}>
        <span className="font-mono">{jobId.slice(0, 8)}</span>
      </SectionTitle>
      {data ? (
        <JobProgressView job={data} />
      ) : error ? (
        <p className="flex items-center gap-3 px-[18px] pb-[18px] text-[12px] text-fg-70" role="alert">
          Couldn&apos;t load this job.
          <button type="button" className="text-violet-soft hover:text-fg" onClick={() => void mutate()}>
            Retry
          </button>
        </p>
      ) : (
        <div className="flex flex-col gap-3 px-[18px] pb-[18px]" aria-busy="true">
          <ShimmerBar className="h-3 w-full" />
          <ShimmerBar className="h-10 w-full" />
          <ShimmerBar className="h-3 w-2/3" />
        </div>
      )}
    </GlassCard>
  )
}
