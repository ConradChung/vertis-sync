'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
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

function Tile({
  label,
  hint,
  tone,
  value,
  delta,
  deltaTone = 'green',
  spark,
  sparkLabel,
  href,
  ariaLabel,
  children,
}: {
  label: string
  hint?: string
  tone: Tone
  value?: ReactNode
  delta?: string
  deltaTone?: 'green' | 'amber' | 'muted'
  spark?: number[]
  sparkLabel?: string
  href?: string
  ariaLabel?: string
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
        <span className="inline-flex items-center gap-1.5">
          {label}
          {hint && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span tabIndex={0} aria-label={hint} className="relative z-10 inline-flex cursor-help text-fg-24 outline-none hover:text-fg-70 focus-visible:text-fg-70">
                    <Info className="size-3" aria-hidden />
                  </span>
                }
              />
              <TooltipContent>{hint}</TooltipContent>
            </Tooltip>
          )}
        </span>
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
      {spark && <Spark data={spark} tone={tone} className="mt-auto pt-[10px]" label={sparkLabel} />}
    </GlassCard>
  )
  return href ? (
    <Link href={href} className="block rounded-panel outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={ariaLabel}>
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
  if (!instantly && !failed) return <ShimmerBar className="mt-[14px] h-3 w-3/4" />
  if (instantly && !instantly.configured) return <NotConnected className="mt-[14px]" />
  return <NotConnected className="mt-[14px]">Instantly unreachable — retrying</NotConnected>
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
  const dash = <span className="text-fg-24">—</span>

  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile
        label="Sent today"
        hint={SENT_HINT}
        tone="violet"
        value={live ? <Num value={live.sent_today ?? 0} /> : dash}
        delta={live ? vsAverage(live.sent_7d ?? []) : undefined}
        deltaTone="muted"
        spark={live?.sent_7d}
        sparkLabel="Sends per day, last 7 days"
      >
        {!live && <InstantlyGap instantly={instantly} failed={instantlyFailed} />}
      </Tile>

      <Tile
        label="Replies today"
        tone="green"
        value={<Num value={data.replies_today} />}
        delta={vsYesterday(data.replies_7d)}
        deltaTone={data.replies_today > 0 ? 'green' : 'muted'}
        spark={data.replies_7d}
        sparkLabel="Replies per day (Pacific), last 7 days"
      />

      <Tile
        label="Pending approvals"
        tone="amber"
        href="/validate"
        ariaLabel={`Pending approvals: ${data.pending_gates}. Open Validate`}
        value={<Num value={data.pending_gates} />}
        delta={data.pending_gates > 0 ? 'Needs attention' : 'All clear'}
        deltaTone={data.pending_gates > 0 ? 'amber' : 'muted'}
        spark={data.gates_opened_7d}
        sparkLabel="Approvals opened per day, last 7 days"
      />

      <Tile
        label="Opportunities"
        hint="Lifetime total across the Instantly workspace (Instantly reports no open count)."
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
        <GlassCard key={i} className="min-h-[142px] gap-3 px-[18px]">
          <ShimmerBar className="h-3 w-24" />
          <ShimmerBar className="h-7 w-16" />
          <ShimmerBar className="mt-auto h-[34px] w-full" />
        </GlassCard>
      ))}
    </div>
  )
}
