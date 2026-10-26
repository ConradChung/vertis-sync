'use client'

import { AnimatedNumber } from '@/components/ui/animated-number'
import { useMemo, type ReactNode } from 'react'
import { useReducedMotion } from '@/lib/motion'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { NotConnected, ShimmerBar } from '@/components/overview/parts'
import { lastNDates, seriesOn } from '@/lib/adapters/instantly.map'
import type { CampaignAnalyticsResponse } from '@/lib/campaigns/types'
import { cn } from '@/lib/utils'
import { allZero, lastActiveDate } from '@/lib/campaigns/chart'

const config = {
  // Black / white / lime only: sent neutral, replies primary, interested full foreground.
  sent: { label: 'Sent', color: 'var(--fg-46)' },
  replies: { label: 'Replies', color: 'var(--chart-line)' },
  opportunities: { label: 'Interested', color: 'var(--fg)' },
} satisfies ChartConfig

const KEYS = ['sent', 'replies', 'opportunities'] as const

export function AnalyticsChart({
  data,
  failed,
  days,
  onDays,
}: {
  data: CampaignAnalyticsResponse | undefined
  failed: boolean
  days: 7 | 30
  onDays: (d: 7 | 30) => void
}) {
  // Series draw in (~800 ms ease-out) and tween when the window/data changes.
  const animate = !useReducedMotion()
  const points = useMemo(() => {
    if (!data?.configured) return []
    const dates = lastNDates(new Date(), days)
    const sent = seriesOn(dates, 'sent', data.daily)
    const replies = seriesOn(dates, 'replies', data.daily)
    const opps = seriesOn(dates, 'opportunities', data.daily)
    return dates.map((d, i) => ({
      date: d.slice(5),
      sent: sent[i],
      replies: replies[i],
      opportunities: opps[i],
    }))
  }, [data, days])

  if (failed && !data)
    return (
      <p className="py-6 text-[13px] text-fg-46" role="alert">
        Couldn&apos;t load Instantly analytics.
      </p>
    )
  if (!data) return <ShimmerBar className="h-[260px] w-full" />
  if (!data.configured) return <NotConnected className="py-6 text-[13px]" />

  const o = data.overview
  const stats: [string, ReactNode][] = [
    ['Sent', <AnimatedNumber key="s" value={o.sent} />],
    ['Replies', <AnimatedNumber key="r" value={o.replies} />],
    ['Reply rate', o.reply_rate === null ? '—' : <AnimatedNumber key="rr" value={o.reply_rate} decimals={1} suffix="%" />],
    ['Interested', <AnimatedNumber key="i" value={o.opportunities} />],
    ['Bounced', <AnimatedNumber key="b" value={o.bounced} />],
  ]
  const maxStep = Math.max(1, ...data.steps.map((s) => s.sent))
  const empty = allZero(points, [...KEYS])
  const lastActive = lastActiveDate(data.daily)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-muted px-3 py-2.5">
            <p className="text-[11px] text-fg-46">{label}</p>
            <p className="mt-0.5 font-mono text-[18px] font-semibold text-fg tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-medium text-fg">
            Daily <span className="font-normal text-fg-46">· last {days} days (totals above are all-time)</span>
          </h3>
          <div className="flex rounded-md border border-white/8 p-0.5 text-[11px]" role="group" aria-label="Range">
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days === d}
                onClick={() => onDays(d)}
                className={cn('rounded-md px-2 py-0.5 transition-colors', days === d ? 'bg-white/10 text-fg' : 'text-fg-46 hover:text-fg')}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          {empty && (
            <p className="pointer-events-none absolute inset-x-0 top-1/3 z-10 text-center text-[12px] text-fg-46" data-testid="chart-empty">
              No sends in the last {days} days
              {lastActive ? ` — last activity ${lastActive}` : ''}.{days === 7 ? ' Try 30d.' : ''}
            </p>
          )}
          <ChartContainer config={config} className="aspect-auto h-[240px] w-full">
            <AreaChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
              <defs>
                {Object.entries(config).map(([k, v]) => (
                  <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={v.color} stopOpacity={0.45} />
                    <stop offset="95%" stopColor={v.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} strokeOpacity={0.08} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
              {/* Overlaid, not stacked: replies/interested are subsets of sent, and Recharts 3
                drops every stacked series (and the Y axis) when the window is all zeros. */}
              {KEYS.map((k) => (
                <Area key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} fill={`url(#fill-${k})`} strokeWidth={1.5} isAnimationActive={animate} animationDuration={800} animationEasing="ease-out" />
              ))}
            </AreaChart>
          </ChartContainer>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-[13px] font-medium text-fg">Step drop-off</h3>
        {data.steps.length === 0 ? (
          <p className="text-[12px] text-fg-46">No step data yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.steps.map((s) => (
              <li key={s.step} className="grid grid-cols-[56px_1fr_auto] items-center gap-3 text-[12px]">
                <span className="text-fg-46">Step {s.step}</span>
                <div className="h-2 overflow-hidden rounded-full bg-white/6">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(s.sent / maxStep) * 100}%` }} />
                </div>
                <span className="font-mono text-fg-46 tabular-nums">
                  <AnimatedNumber value={s.sent} /> sent · <AnimatedNumber value={s.replies} /> replies
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
