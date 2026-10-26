'use client'

import { useReducedMotion } from 'motion/react'
import { NumberTicker } from '@/components/ui/number-ticker'
import { cn } from '@/lib/utils'

/**
 * A count-up number (NumberTicker) that renders the plain, formatted value
 * under prefers-reduced-motion. Always tabular. `decimals` fixes the
 * fraction digits; prefix/suffix (e.g. "%") stay static beside it.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  prefix,
  suffix,
  className,
}: {
  value: number
  decimals?: number
  prefix?: string
  suffix?: string
  className?: string
}) {
  const reduce = useReducedMotion()
  // The ticker starts when it scrolls into view (IntersectionObserver); where
  // that API is missing (old engines, jsdom) show the value as-is.
  const canTick = typeof window === 'undefined' || 'IntersectionObserver' in window
  const safe = Number.isFinite(value) ? value : 0
  const plain = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(safe)
  return (
    <span className={cn('tabular-nums', className)}>
      {prefix}
      {reduce || !canTick ? plain : <NumberTicker value={safe} decimalPlaces={decimals} />}
      {suffix}
    </span>
  )
}
