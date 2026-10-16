'use client'

import { Clock } from 'lucide-react'
import { GlassCard } from '@/components/ui/glass-card'
import { EmptyLine, SectionTitle, useNow } from '@/components/overview/parts'
import { countdown } from '@/lib/overview/compute'
import type { ScheduledJobWithNext } from '@/lib/overview/types'

const RUNNER: Record<string, string> = { pg_cron: 'pg_cron', claude: 'Claude task', vercel: 'Vercel cron', rotation_rule: 'rotation rule' }

function utcTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`
}

/** The next three runs with a once-a-second countdown (text only; nothing animates). */
export function NextRuns({ jobs, total }: { jobs: ScheduledJobWithNext[]; total: number }) {
  const now = useNow(1000)
  return (
    <GlassCard className="gap-0 py-0" aria-label="Next runs">
      <SectionTitle title="Next runs">
        <span className="font-mono tabular-nums">{total} scheduled</span>
      </SectionTitle>
      {jobs.length === 0 ? (
        <EmptyLine text="Nothing scheduled." action={{ label: 'Rotation rules', href: '/rotate' }} />
      ) : (
        <ul>
          {jobs.map((j) => (
            <li key={j.name} className="flex items-center gap-3 border-b border-white/8 px-[18px] py-[15px] last:border-b-0">
              <div className="grid size-[30px] flex-none place-items-center rounded-[9px] bg-accent text-violet-soft" aria-hidden>
                <Clock className="size-[15px]" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-fg">{j.name}</div>
                <div className="truncate font-mono text-[10px] text-fg-46">
                  {j.cron} · {RUNNER[j.runner] ?? j.runner}
                  {j.next_run && ` · ${utcTime(j.next_run)}`}
                  {j.last_status && j.last_status !== 'succeeded' && <span className="text-amber"> · last {j.last_status}</span>}
                </div>
              </div>
              <time dateTime={j.next_run ?? undefined} className="ml-auto shrink-0 font-mono text-[11px] text-violet-soft tabular-nums" suppressHydrationWarning>
                {countdown(j.next_run, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  )
}
