'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useReducedMotion } from 'motion/react'
import { NumberTicker } from '@/components/ui/number-ticker'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { HealthLevel } from '@/lib/overview/types'
import { cn } from '@/lib/utils'

/** Shared bits for the Overview cards. */

export type Tone = 'violet' | 'green' | 'amber' | 'cyan' | 'red'

export const TONE_VAR: Record<Tone, string> = {
  violet: 'var(--violet)',
  green: 'var(--green)',
  amber: 'var(--amber)',
  cyan: 'var(--cyan)',
  red: 'var(--red)',
}

const HEALTH_VAR: Record<HealthLevel, string> = {
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  idle: 'var(--fg-24)',
}

const fmt = new Intl.NumberFormat('en-US')

/** Counts up on change; a plain number under reduced motion. */
export function Num({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion()
  if (reduce) return <span className={cn('tabular-nums', className)}>{fmt.format(value)}</span>
  return <NumberTicker value={value} className={cn('tracking-normal text-fg', className)} />
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

/** Inline-SVG sparkline (the prototype's `Spark`): line + soft fill. */
export function Spark({
  data,
  tone = 'violet',
  className,
  label,
}: {
  data: number[]
  tone?: Tone
  className?: string
  label?: string
}) {
  const gid = useId().replace(/:/g, '')
  if (data.length < 2) return <div className={cn('h-[34px]', className)} aria-hidden />
  const W = 100
  const H = 34
  const max = Math.max(...data)
  const min = Math.min(...data)
  const span = max - min || 1
  const pts = data.map((v, i) => [(i / (data.length - 1)) * W, H - 3 - ((v - min) / span) * (H - 6)] as const)
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `0,${H} ${line} ${W},${H}`
  const color = TONE_VAR[tone]
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn('h-[34px] w-full overflow-visible', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={`sg${gid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#sg${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function HealthDot({ level, reason }: { level: HealthLevel; reason: string }) {
  const color = HEALTH_VAR[level]
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`${level}: ${reason}`}
            tabIndex={0}
            className="inline-block size-[7px] shrink-0 cursor-help rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ background: color, boxShadow: level === 'idle' ? 'none' : `0 0 8px ${color}` }}
          />
        }
      />
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

export function SectionTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-[18px] pt-[18px] pb-2">
      <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
      {children && <div className="flex items-center gap-2 text-[11px] text-fg-46">{children}</div>}
    </div>
  )
}

/** Muted single line for a tile/card whose source is not connected. */
export function NotConnected({ children = 'Instantly not connected — set INSTANTLY_API_KEY', className }: { children?: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-center gap-2 text-[11px] leading-snug text-fg-46', className)}>
      <span className="inline-block size-[6px] shrink-0 rounded-full bg-fg-24" aria-hidden />
      {children}
    </p>
  )
}

/** Empty state: one line + one action. */
export function EmptyLine({ text, action }: { text: string; action?: { label: string; href: string; external?: boolean } }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-[18px] py-6 text-[13px] text-fg-46">
      <span>{text}</span>
      {action &&
        (action.external ? (
          <a href={action.href} target="_blank" rel="noreferrer" className="text-[12px] text-violet-soft hover:text-fg">
            {action.label} ↗
          </a>
        ) : (
          <Link href={action.href} className="text-[12px] text-violet-soft hover:text-fg">
            {action.label} →
          </Link>
        ))}
    </div>
  )
}

export function ShimmerBar({ className }: { className?: string }) {
  return <div className={cn('anim-shimmer h-4', className)} aria-hidden />
}
