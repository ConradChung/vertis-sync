'use client'

import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { NotConnected, ShimmerBar } from '@/components/overview/parts'
import { lastNDates, seriesOn } from '@/lib/adapters/instantly.map'
import type { CampaignAnalyticsResponse } from '@/lib/campaigns/types'
import { cn } from '@/lib/utils'

const config = {
  sent: { label: 'Sent', color: 'var(--violet)' },
  replies: { label: 'Replies', color: 'var(--green)' },
  opportunities: { label: 'Interested', color: 'var(--amber)' },
} satisfies ChartConfig

const fmt = new Intl.NumberFormat('en-US')

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
  const points = useMemo(() => {
    if (!data?.configured) return []
    const dates = lastNDates(new Date(), days)
    const sent = seriesOn(dates, 'sent', data.daily)
    const replies = seriesOn(dates, 'replies', data.daily)
    const opps = seriesOn(dates, 'opportunities', data.daily)
    return dates.map((d, i) => ({ date: d.slice(5), sent: sent[i], replies: replies[i], opportunities: opps[i] }))
  }, [data, days])

  if (failed && !data) return <p className="py-6 text-[13px] text-fg-46" role="alert">Couldn&apos;t load Instantly analytics.</p>
  if (!data) return <ShimmerBar className="h-[260px] w-full" />
  if (!data.configured) return <NotConnected className="py-6 text-[13px]" />

  const o = data.overview
  const stats: [string, string][] = [
    ['Sent', fmt.format(o.sent)],
    ['Replies', fmt.format(o.replies)],
    ['Reply rate', o.reply_rate === null ? '—' : `${o.reply_rate.toFixed(1)}%`],
    ['Interested', fmt.format(o.opportunities)],
    ['Bounced', fmt.format(o.bounced)],
  ]
  const maxStep = Math.max(1, ...data.steps.map((s) => s.sent))

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-white/8 bg-white/3 px-3 py-2.5">
            <p className="text-[11px] text-fg-46">{label}</p>
            <p className="mt-0.5 font-mono text-[18px] font-semibold text-fg tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-medium text-fg">Daily</h3>
          <div className="flex rounded-md border border-white/8 p-0.5 text-[11px]" role="group" aria-label="Range">
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days === d}
                onClick={() => onDays(d)}
                className={cn('rounded px-2 py-0.5', days === d ? 'bg-white/10 text-fg' : 'text-fg-46 hover:text-fg')}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
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
            {(['sent', 'replies', 'opportunities'] as const).map((k) => (
              <Area
                key={k}
                dataKey={k}
                type="monotone"
                stackId="a"
                stroke={`var(--color-${k})`}
                fill={`url(#fill-${k})`}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ChartContainer>
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
                  <div className="h-full rounded-full bg-violet" style={{ width: `${(s.sent / maxStep) * 100}%` }} />
                </div>
                <span className="font-mono text-fg-46 tabular-nums">
                  {fmt.format(s.sent)} sent · {fmt.format(s.replies)} replies
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
