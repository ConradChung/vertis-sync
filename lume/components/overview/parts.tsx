'use client'

import { useEffect, useId, useState, type HTMLAttributes, type ReactNode } from 'react'
import Link from 'next/link'
import { Area, AreaChart, Line, LineChart, YAxis } from 'recharts'
import { useReducedMotion } from 'motion/react'
import { NumberTicker } from '@/components/ui/number-ticker'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { HealthLevel } from '@/lib/overview/types'
import { cn } from '@/lib/utils'

/** Shared bits for the Overview cards. */

/**
 * Sparkline tone: `lime` = the primary series (lime line in dark, forest-green
 * line with lime points/area in light) · `violet` = secondary / automation.
 */
export type Tone = 'violet' | 'lime'

/** Line, area and point colours per tone (all theme tokens). */
export const TONE_VAR: Record<Tone, { line: string; area: string; point: string }> = {
  lime: { line: 'var(--chart-line)', area: 'var(--chart-area)', point: 'var(--chart-point)' },
  violet: { line: 'var(--violet)', area: 'var(--violet)', point: 'var(--violet)' },
}

/** Status dots: lime healthy · violet needs you · destructive error · faint idle. */
const HEALTH: Record<HealthLevel, { color: string; word: string }> = {
  green: { color: 'var(--lime)', word: 'healthy' },
  amber: { color: 'var(--violet)', word: 'needs attention' },
  red: { color: 'var(--destructive)', word: 'error' },
  idle: { color: 'var(--fg-35)', word: 'no data' },
}

const fmt = new Intl.NumberFormat('en-US')

/** Counts up on change; a plain number under reduced motion. */
export function Num({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion()
  if (reduce) return <span className={cn('tabular-nums', className)}>{fmt.format(value)}</span>
  return <NumberTicker value={value} className={cn('tracking-tight text-foreground', className)} />
}

/** Re-renders every `intervalMs` with the current time. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** Lime when the series ends at or above where it started (and moved), else violet. */
export function trendTone(data: number[]): Tone {
  if (data.length < 2) return 'violet'
  const first = data[0]
  const last = data[data.length - 1]
  return last > first ? 'lime' : 'violet'
}

/**
 * Single-series recharts sparkline inside shadcn's ChartContainer. `area`
 * fills under the line with a colour→transparent gradient and marks the
 * latest point. In dark the line glows (`--chart-glow`); light has no glow.
 */
export function Spark({
  data,
  tone,
  className,
  label,
  variant = 'line',
}: {
  data: number[]
  /** Defaults to the sign of the trend. */
  tone?: Tone
  className?: string
  label?: string
  variant?: 'line' | 'area'
}) {
  const gradientId = `spark-${useId().replace(/:/g, '')}`
  if (data.length < 2) return <div className={cn('h-9', className)} aria-hidden />
  const c = TONE_VAR[tone ?? trendTone(data)]
  const config: ChartConfig = { v: { label: label ?? 'value', color: c.line } }
  const rows = data.map((v, i) => ({ i, v }))
  const last = rows.length - 1
  return (
    <div
      className={cn('h-9 w-full [&_.recharts-curve]:[filter:var(--chart-glow)]', className)}
      style={{ color: c.line }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <ChartContainer config={config} className="aspect-auto h-full w-full" initialDimension={{ width: 240, height: 36 }}>
        {variant === 'area' ? (
          <AreaChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} accessibilityLayer={false}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c.area} stopOpacity={0.35} />
                <stop offset="100%" stopColor={c.area} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[(min: number) => min - (min === 0 ? 0 : min * 0.15), 'dataMax']} />
            <Area
              dataKey="v"
              type="monotone"
              stroke="var(--color-v)"
              strokeWidth={1.75}
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              dot={(p: { index?: number; cx?: number; cy?: number }) =>
                p.index === last && p.cx != null && p.cy != null ? (
                  <circle key="last" cx={p.cx} cy={p.cy} r={3} fill={c.point} stroke={c.line} strokeWidth={1.5} />
                ) : (
                  <g key={p.index} />
                )
              }
            />
          </AreaChart>
        ) : (
          <LineChart data={rows} margin={{ top: 3, right: 2, bottom: 3, left: 2 }} accessibilityLayer={false}>
            <YAxis hide domain={['dataMin', 'dataMax']} />
            <Line dataKey="v" type="linear" stroke="var(--color-v)" strokeWidth={1.75} dot={false} isAnimationActive={false} />
          </LineChart>
        )}
      </ChartContainer>
    </div>
  )
}

/** 6 px status dot with its reason in a tooltip; the label carries the words. */
export function HealthDot({ level, reason }: { level: HealthLevel; reason: string }) {
  const h = HEALTH[level]
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`${h.word}: ${reason}`}
            tabIndex={0}
            className={cn(
              'inline-block size-1.5 shrink-0 cursor-help rounded-full bg-current shadow-(--dot-glow) outline-none focus-visible:ring-2 focus-visible:ring-ring',
              // Light: lime sits on a forest-green ring so the dot holds 3:1 on white glass.
              level === 'green' && 'light:size-2 light:border-[1.5px] light:border-forest'
            )}
            style={{ color: h.color }}
          />
        }
      />
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

/** Visually hidden, for screen readers only. */
export function SrOnly({ children, ...props }: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="sr-only" {...props}>
      {children}
    </span>
  )
}

export function SectionTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children && <div className="flex items-center gap-2 text-xs text-muted-foreground">{children}</div>}
    </div>
  )
}

/** Muted single line for a tile/card whose source is not connected. */
export function NotConnected({ children = 'Instantly not connected — set INSTANTLY_API_KEY', className }: { children?: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-center gap-2 text-xs leading-snug text-muted-foreground', className)}>
      <span className="inline-block size-1.5 shrink-0 rounded-full bg-(--fg-35)" aria-hidden />
      {children}
    </p>
  )
}

/** Empty state: one line + one action. */
export function EmptyLine({ text, action }: { text: string; action?: { label: string; href: string; external?: boolean } }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-muted-foreground">
      <span>{text}</span>
      {action &&
        (action.external ? (
          <a href={action.href} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
            {action.label} ↗
          </a>
        ) : (
          <Link href={action.href} className="text-xs text-primary hover:underline">
            {action.label} →
          </Link>
        ))}
    </div>
  )
}

/** Loading placeholder (shadcn Skeleton). `anim-shimmer` stays as a stable hook for tests. */
export function ShimmerBar({ className }: { className?: string }) {
  return <Skeleton className={cn('anim-shimmer h-4', className)} aria-hidden />
}
