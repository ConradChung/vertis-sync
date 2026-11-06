'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { JobProgress } from '@/components/validate/JobProgress'
import { useRecentJobs } from '@/hooks/useJob'
import { ago } from '@/lib/import/format'
import { partitionJobs, showsError, type JobSummary } from '@/lib/validate/jobs'
import { cn } from '@/lib/utils'

/**
 * The Validate page's "Running" section, read-only: validation jobs still
 * pending / processing, each with the JobProgress panel (verify bar, verdict
 * counts, ETA, enrich bar), and below them, collapsed, the jobs finished in
 * the last 24 h with their error_message (a failed job never just vanishes).
 * Shown whether or not any gate waits; renders nothing when there is no job.
 */
export function RunningJobs() {
  const { data } = useRecentJobs()
  if (!data) return null
  const { running, recent } = partitionJobs(data.jobs)
  if (!running.length && !recent.length) return null
  return (
    <section aria-label="Running jobs" className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-fg">Running</h2>
      {running.length ? (
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {running.map((j) => (
            <div key={j.id} role="group" aria-label={j.filename ?? j.id} className="flex flex-col gap-1.5">
              <JobMeta job={j} />
              <JobProgress jobId={j.id} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-fg-46">No job is running right now.</p>
      )}
      {recent.length > 0 && (
        <details className="group rounded-panel border border-line bg-white/4 px-4 py-2.5">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-fg-70 select-none hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            Finished in the last 24 h ({recent.length})
          </summary>
          <ul className="mt-2.5 flex flex-col gap-2.5">
            {recent.map((j) => (
              <FinishedJob key={j.id} job={j} />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

const STATUS_TONE: Record<string, string> = { failed: 'text-red', cancelled: 'text-amber', completed: 'text-green' }

function JobMeta({ job }: { job: JobSummary }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-fg-46">
      <span className="truncate font-medium text-fg-70">{job.filename ?? 'Untitled job'}</span>
      <span aria-hidden>·</span>
      <span className={cn('font-mono', STATUS_TONE[job.status ?? ''] ?? 'text-cyan')}>{job.status ?? 'unknown'}</span>
      <span aria-hidden>·</span>
      <span title={new Date(job.created_at).toLocaleString()}>started {ago(job.created_at)}</span>
    </p>
  )
}

function FinishedJob({ job }: { job: JobSummary }) {
  // Progress loads only when opened: no per-job fetch for a collapsed list.
  const [open, setOpen] = useState(false)
  const reason = showsError(job)
  return (
    <li className="flex flex-col gap-1.5">
      <JobMeta job={job} />
      <p className="font-mono text-[11px] text-fg-46 tabular-nums">
        {job.processed_rows.toLocaleString('en-US')} / {job.total_rows.toLocaleString('en-US')} processed · updated {ago(job.updated_at)}
      </p>
      {reason && (
        <p className={cn('text-[12px]', job.status === 'failed' ? 'text-red' : 'text-amber')} role="note">
          {reason}
        </p>
      )}
      <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-[11px] text-violet-soft hover:text-fg">Show progress</summary>
        {open && (
          <div className="mt-2">
            <JobProgress jobId={job.id} />
          </div>
        )}
      </details>
    </li>
  )
}
