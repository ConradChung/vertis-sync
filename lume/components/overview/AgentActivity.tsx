'use client'

import { GlassCard } from '@/components/ui/glass-card'
import { EmptyLine, SectionTitle, useNow } from '@/components/overview/parts'
import { timeAgo } from '@/lib/overview/compute'
import type { EventRow } from '@/lib/db/types'

/** `agent.*` and `lume.*` events as a mono log. */
export function AgentActivity({ events }: { events: EventRow[] }) {
  const now = useNow(30_000)
  return (
    <GlassCard className="gap-0 py-0" aria-label="Agent activity">
      <SectionTitle title="Agent activity" />
      {events.length === 0 ? (
        <EmptyLine text="No agent or Lume actions yet." action={{ label: 'Approvals', href: '/validate' }} />
      ) : (
        <ul className="px-5 pb-3">
          {events.slice(0, 8).map((ev) => (
            <li key={ev.id} className="flex items-baseline gap-3 border-b border-border py-2 font-mono text-xs last:border-b-0">
              <time dateTime={ev.created_at} className="w-[52px] shrink-0 text-white/25 tabular-nums" suppressHydrationWarning>
                {timeAgo(ev.created_at, now)}
              </time>
              <span className="min-w-0 flex-1 truncate text-white/70" title={ev.title}>
                {ev.title}
              </span>
              <span className="shrink-0 text-[11px] text-violet-soft">{ev.type}</span>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  )
}
