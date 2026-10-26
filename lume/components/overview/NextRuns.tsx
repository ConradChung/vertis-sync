'use client'

import { Clock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
            <li key={j.name} className="flex items-center gap-3 border-t border-border px-5 py-3">
              <Clock size={16} strokeWidth={1.75} className="shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{j.name}</div>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline" className="rounded-md font-mono font-normal text-foreground">
                    {j.cron}
                  </Badge>
                  <span className="truncate">{RUNNER[j.runner] ?? j.runner}</span>
                  {j.next_run && <span className="font-mono tabular-nums">· {utcTime(j.next_run)}</span>}
                  {j.last_status && j.last_status !== 'succeeded' && <span className="text-destructive">· last {j.last_status}</span>}
                </div>
              </div>
              <time dateTime={j.next_run ?? undefined} className="ml-auto shrink-0 font-mono text-sm text-foreground tabular-nums" suppressHydrationWarning>
                {countdown(j.next_run, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  )
}
