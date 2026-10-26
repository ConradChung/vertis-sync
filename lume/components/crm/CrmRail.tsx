'use client'

import { Spark } from '@/components/overview/parts'
import { GlassCard } from '@/components/ui/glass-card'
import { MAIN_LINE } from '@/lib/crm/stages'
import type { CrmBoardResponse } from '@/lib/crm/types'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

function Tile({ label, value, delta, tone, className, children }: {
  label: string
  value: string
  delta?: string
  tone?: 'up' | 'down' | 'muted'
  className?: string
  children?: React.ReactNode
}) {
  return (
    <GlassCard size="sm" className={cn('gap-1 px-3.5', className)}>
      <div className="eyebrow leading-tight">{label}</div>
      <div className="font-mono text-2xl leading-none font-semibold tracking-tight text-foreground tabular-nums" data-testid="crm-tile-value">
        {value}
      </div>
      {delta && (
        <div className={cn('font-mono text-[11px] tabular-nums', tone === 'up' && 'text-positive', tone === 'down' && 'text-destructive', (!tone || tone === 'muted') && 'text-muted-foreground')}>
          {delta}
        </div>
      )}
      {children}
    </GlassCard>
  )
}

/**
 * Left rail: stage-count tiles (main line, then side exits), reply-rate
 * sparkline (14 owner-zone days, with the last-7 vs prior-7 delta) and
 * follow-ups due today.
 */
export function CrmRail({ data }: { data: CrmBoardResponse }) {
  const counts: Record<string, number> = {}
  for (const d of data.deals) counts[d.stage] = (counts[d.stage] ?? 0) + 1
  const total = data.deals.length
  const replied = data.deals.filter((d) => d.stage !== 'Contacted' && d.stage !== 'Bounced').length
  const rate = total ? Math.round((replied / total) * 1000) / 10 : null
  const last7 = data.replies_14d.slice(-7).reduce((a, b) => a + b, 0)
  const prev7 = data.replies_14d.slice(0, 7).reduce((a, b) => a + b, 0)
  const diff = last7 - prev7
  const main = data.stages.filter((s) => (MAIN_LINE as readonly string[]).includes(s.name))
  const side = data.stages.filter((s) => !(MAIN_LINE as readonly string[]).includes(s.name))

  return (
    <div className="flex flex-col gap-2.5" aria-label="Pipeline summary">
      <div className="grid grid-cols-2 gap-2.5">
        {main.map((s) => (
          <Tile key={s.name} label={s.name} value={fmt.format(counts[s.name] ?? 0)} className={s.name === 'Contacted' ? 'col-span-2' : undefined} />
        ))}
      </div>
      <GlassCard size="sm" className="gap-1.5 px-3.5">
        {side.map((s) => (
          <div key={s.name} className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{s.name}</span>
            <span className="font-mono text-foreground tabular-nums">{fmt.format(counts[s.name] ?? 0)}</span>
          </div>
        ))}
      </GlassCard>
      <Tile
        label="Reply rate"
        value={rate === null ? '—' : `${rate}%`}
        delta={`${diff > 0 ? '+' : ''}${diff} replies vs prior 7d`}
        tone={diff > 0 ? 'up' : diff < 0 ? 'down' : 'muted'}
      >
        <Spark data={data.replies_14d} variant="area" className="mt-1 h-10" label={`Replies per day, last ${data.replies_14d.length} days`} />
      </Tile>
      <Tile
        label="Follow-ups due"
        value={fmt.format(data.followups.length)}
        delta={`${data.due_today} more later today`}
        tone={data.followups.length > 0 ? 'down' : 'muted'}
      />
    </div>
  )
}
