'use client'

import { Clock } from 'lucide-react'
import { GlassCard } from '@/components/ui/glass-card'
import { EmptyLine, SectionTitle, useNow } from '@/components/overview/parts'
import { useMemo } from 'react'
import { countdown } from '@/lib/overview/compute'
import type { ScheduledJobWithNext } from '@/lib/overview/types'
import { upcoming, withNextRun } from '@/lib/schedule/nextRun'

const RUNNER: Record<string, string> = { pg_cron: 'pg_cron', claude: 'Claude task', vercel: 'Vercel cron', rotation_rule: 'rotation rule' }

function utcTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`
}

/**
 * The next three runs with a once-a-second countdown (text only; nothing
 * animates). When a run comes due, its next occurrence is recomputed here
 * from the cron (cron-parser, UTC) instead of sitting at "due" until the
 * next poll.
 */
export function NextRuns({ scheduled }: { scheduled: ScheduledJobWithNext[] }) {
  const now = useNow(1000)
  // Recompute only when some shown run has passed (changes the memo key).
  const dueKey = scheduled.filter((j) => j.next_run && Date.parse(j.next_run) <= now).length
  const minute = Math.floor(now / 60_000)
  const jobs = useMemo(
    () => upcoming(dueKey ? withNextRun(scheduled, new Date(minute * 60_000 + 1000)) : scheduled, 3),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute per due change / minute only
    [scheduled, dueKey, dueKey ? minute : 0]
  )
  const total = scheduled.length
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
