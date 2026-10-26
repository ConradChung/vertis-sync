'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight, Info } from 'lucide-react'
import { GlassCard } from '@/components/ui/glass-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NotConnected, Num, ShimmerBar, Spark, type Tone } from '@/components/overview/parts'
import type { OverviewInstantly } from '@/lib/overview/types'
import { cn } from '@/lib/utils'

export interface KpiData {
  replies_today: number
  /** Owner-zone days; the last bucket is today. */
  replies_7d: number[]
  pending_gates: number
  /** Gates opened per owner-zone day (`lume.gate_ping`). */
  gates_opened_7d: number[]
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

type DeltaTone = 'positive' | 'attention' | 'muted'

function Tile({
  label,
  hint,
  value,
  delta,
  deltaTone = 'muted',
  spark,
  sparkTone,
  sparkLabel,
  href,
  ariaLabel,
  children,
}: {
  label: string
  hint?: string
  value?: ReactNode
  delta?: string
  deltaTone?: DeltaTone
  spark?: number[]
  sparkTone?: Tone
  sparkLabel?: string
  href?: string
  ariaLabel?: string
  children?: ReactNode
}) {
  const body = (
    <GlassCard className={cn('h-full min-h-[176px] gap-0 p-5 pb-[76px]', href && 'transition-colors hover:bg-accent')}>
      <div className="relative z-10 flex items-center justify-between text-sm font-medium text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          {label}
          {hint && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span tabIndex={0} aria-label={hint} className="relative z-10 inline-flex cursor-help text-white/25 outline-none hover:text-muted-foreground focus-visible:text-muted-foreground">
                    <Info size={14} strokeWidth={1.75} aria-hidden />
                  </span>
                }
              />
              <TooltipContent>{hint}</TooltipContent>
            </Tooltip>
          )}
        </span>
        {href && (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
            Review <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
          </span>
        )}
      </div>
      {value !== undefined && (
        <div className="relative z-10 mt-3 mb-1 font-mono text-3xl leading-none font-semibold tracking-tight text-foreground tabular-nums" data-testid="kpi-value">
          {value}
        </div>
      )}
      {delta && (
        <div className={cn('relative z-10 text-xs', deltaTone === 'positive' && 'text-positive', deltaTone === 'attention' && 'text-violet-soft', deltaTone === 'muted' && 'text-muted-foreground')}>
          {delta}
        </div>
      )}
      {children && <div className="relative z-10">{children}</div>}
      {/* Sparkline: an area chart filling the bottom 40% of the tile. */}
      {spark && <Spark data={spark} tone={sparkTone} variant="area" className="absolute inset-x-0 bottom-0 h-[40%]" label={sparkLabel} />}
    </GlassCard>
  )
  return href ? (
    <Link href={href} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={ariaLabel}>
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

/** The Instantly tiles' value when there's no number: loading, not connected, or unreachable. */
function InstantlyGap({ instantly, failed }: { instantly: OverviewInstantly | undefined; failed?: boolean }) {
  if (!instantly && !failed) return <ShimmerBar className="mt-3 h-3 w-3/4" />
  if (instantly && !instantly.configured) return <NotConnected className="mt-3" />
  return <NotConnected className="mt-3">Instantly unreachable — retrying</NotConnected>
}

const SENT_HINT = "Workspace-wide. Instantly's own day (its workspace timezone), which can differ from Pacific."

/**
 * `instantly` is the separate `/api/overview/instantly` response: undefined
 * while it loads, `instantlyFailed` when that request errored.
 */
export function KpiTiles({
  data,
  instantly,
  instantlyFailed = false,
}: {
  data: KpiData
  instantly: OverviewInstantly | undefined
  instantlyFailed?: boolean
}) {
  const live = instantly?.configured && !instantly.error ? instantly : null
  const sentDelta = live ? vsAverage(live.sent_7d ?? []) : undefined
  const dash = <span className="text-white/25">—</span>

  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile
        label="Sent today"
        hint={SENT_HINT}
        value={live ? <Num value={live.sent_today ?? 0} /> : dash}
        delta={sentDelta}
        deltaTone={sentDelta?.startsWith('+') ? 'positive' : 'muted'}
        spark={live?.sent_7d}
        sparkLabel="Sends per day, last 7 days"
      >
        {!live && <InstantlyGap instantly={instantly} failed={instantlyFailed} />}
      </Tile>

      <Tile
        label="Replies today"
        value={<Num value={data.replies_today} />}
        delta={vsYesterday(data.replies_7d)}
        deltaTone={data.replies_today > 0 ? 'positive' : 'muted'}
        spark={data.replies_7d}
        sparkLabel="Replies per day (Pacific), last 7 days"
      />

      <Tile
        label="Pending approvals"
        href="/validate"
        ariaLabel={`Pending approvals: ${data.pending_gates}. Open Validate`}
        value={<Num value={data.pending_gates} />}
        delta={data.pending_gates > 0 ? 'Needs attention' : 'All clear'}
        deltaTone={data.pending_gates > 0 ? 'attention' : 'muted'}
        spark={data.gates_opened_7d}
        sparkTone="violet"
        sparkLabel="Approvals opened per day, last 7 days"
      />

      <Tile
        label="Opportunities"
        hint="Lifetime total across the Instantly workspace (Instantly reports no open count)."
        value={
          live ? (
            <span className="inline-flex items-baseline gap-2">
              <Num value={live.opportunities ?? 0} />
              {live.opportunities_value_usd != null && (
                <span className="text-lg text-muted-foreground">· {usd.format(live.opportunities_value_usd)}</span>
              )}
            </span>
          ) : (
            dash
          )
        }
        delta={live ? 'Lifetime, all campaigns' : undefined}
        deltaTone="muted"
        spark={live?.opportunities_7d}
        sparkLabel="New opportunities per day, last 7 days"
      >
        {!live && <InstantlyGap instantly={instantly} failed={instantlyFailed} />}
      </Tile>
    </section>
  )
}

export function KpiTilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <GlassCard key={i} className="min-h-[176px] gap-3 p-5">
          <ShimmerBar className="h-3 w-24" />
          <ShimmerBar className="h-7 w-16" />
          <ShimmerBar className="mt-auto h-9 w-full" />
        </GlassCard>
      ))}
    </div>
  )
}
