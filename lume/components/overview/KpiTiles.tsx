'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { GlassCard } from '@/components/ui/glass-card'
import { NotConnected, Num, ShimmerBar, Spark, type Tone } from '@/components/overview/parts'
import type { InstantlySummary } from '@/lib/overview/types'
import { cn } from '@/lib/utils'

export interface KpiData {
  replies_today: number
  replies_7d: number[]
  pending_gates: number
  instantly: InstantlySummary
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

function Tile({
  label,
  tone,
  value,
  delta,
  deltaTone = 'green',
  spark,
  href,
  children,
}: {
  label: string
  tone: Tone
  value?: ReactNode
  delta?: string
  deltaTone?: 'green' | 'amber' | 'muted'
  spark?: number[]
  href?: string
  children?: ReactNode
}) {
  const body = (
    <GlassCard
      className={cn(
        'min-h-[142px] gap-0 px-[18px] after:pointer-events-none after:absolute after:inset-0 after:bg-[linear-gradient(110deg,transparent_45%,rgba(255,255,255,.035)_50%,transparent_55%)]',
        href && 'transition-colors hover:border-white/20'
      )}
      data-tone={tone}
    >
      <div className="flex items-center justify-between text-[12px] text-fg-70">
        <span>{label}</span>
        {href && <span className="hidden text-[11px] text-fg-46 sm:inline">Review →</span>}
      </div>
      {value !== undefined && (
        <div className="mt-[13px] mb-1 font-mono text-[28px] leading-none font-semibold tracking-[-1px] text-fg tabular-nums" data-testid="kpi-value">
          {value}
        </div>
      )}
      {delta && (
        <div className={cn('text-[11px]', deltaTone === 'green' && 'text-green', deltaTone === 'amber' && 'text-amber', deltaTone === 'muted' && 'text-fg-46')}>
          {delta}
        </div>
      )}
      {children}
      {spark && <Spark data={spark} tone={tone} className="mt-auto pt-[10px]" />}
    </GlassCard>
  )
  return href ? (
    <Link href={href} className="block rounded-panel outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${label}: open Validate`}>
      {body}
    </Link>
  ) : (
    body
  )
}

function vsAverage(series: number[]): string | undefined {
  if (series.length < 2) return undefined
  const today = series[series.length - 1]
  const prior = series.slice(0, -1)
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length
  if (avg === 0) return today > 0 ? 'First sends this week' : 'Nothing sent this week'
  const pct = ((today - avg) / avg) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs 7-day avg`
}

function vsYesterday(series: number[]): string {
  const today = series[series.length - 1] ?? 0
  const yesterday = series[series.length - 2] ?? 0
  const d = today - yesterday
  if (d === 0) return yesterday === 0 ? 'None yesterday either' : 'Same as yesterday'
  return `${d > 0 ? '+' : ''}${d} from yesterday`
}

function InstantlyGap({ instantly }: { instantly: InstantlySummary }) {
  if (!instantly.configured) return <NotConnected className="mt-[14px]" />
  return <NotConnected className="mt-[14px]">Instantly unreachable — retrying</NotConnected>
}

export function KpiTiles({ data }: { data: KpiData }) {
  const ins = data.instantly
  const live = ins.configured && !ins.error ? ins : null

  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile label="Sent today" tone="violet" value={live ? <Num value={live.sent_today ?? 0} /> : <span className="text-fg-24">—</span>} delta={live ? vsAverage(live.sent_7d ?? []) : undefined} deltaTone="muted" spark={live?.sent_7d}>
        {!live && <InstantlyGap instantly={ins} />}
      </Tile>

      <Tile
        label="Replies today"
        tone="green"
        value={<Num value={data.replies_today} />}
        delta={vsYesterday(data.replies_7d)}
        deltaTone={data.replies_today > 0 ? 'green' : 'muted'}
        spark={data.replies_7d}
      />

      <Tile
        label="Pending approvals"
        tone="amber"
        href="/validate"
        value={<Num value={data.pending_gates} />}
        delta={data.pending_gates > 0 ? 'Needs attention' : 'All clear'}
        deltaTone={data.pending_gates > 0 ? 'amber' : 'muted'}
      />

      <Tile
        label="Open opportunities"
        tone="cyan"
        value={
          live ? (
            <span className="inline-flex items-baseline gap-2">
              <Num value={live.opportunities ?? 0} />
              {live.opportunities_value_usd != null && (
                <span className="text-[18px] text-fg-70">· {usd.format(live.opportunities_value_usd)}</span>
              )}
            </span>
          ) : (
            <span className="text-fg-24">—</span>
          )
        }
        delta={live ? 'Across Instantly campaigns' : undefined}
        deltaTone="muted"
        spark={live?.opportunities_7d}
      >
        {!live && <InstantlyGap instantly={ins} />}
      </Tile>
    </section>
  )
}

export function KpiTilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <GlassCard key={i} className="min-h-[142px] gap-3 px-[18px]">
          <ShimmerBar className="h-3 w-24" />
          <ShimmerBar className="h-7 w-16" />
          <ShimmerBar className="mt-auto h-[34px] w-full" />
        </GlassCard>
      ))}
    </div>
  )
}
