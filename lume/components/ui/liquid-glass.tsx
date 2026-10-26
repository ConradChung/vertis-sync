'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export type LiquidGlassProps = React.ComponentProps<'div'> & {
  /** `regular` (default) for nav & controls. `clear` only over rich media with bold, bright content on top. */
  variant?: 'regular' | 'clear'
  /** Violet tint — primary actions only. */
  tint?: boolean
  /** Flex + internal glow that follows the pointer. */
  interactive?: boolean
  /** Thicker material for large surfaces (sheets, bars): deeper shadow and blur. */
  thick?: boolean
}

/**
 * Liquid Glass surface for the navigation / control layer (bars, sheets,
 * popovers, floating action bars). Never use it for content cards — that's
 * `GlassCard` (surface variant). Glass nested in glass flattens to a fill
 * automatically (see globals.css).
 */
export function LiquidGlass({ variant = 'regular', tint, interactive, thick, className, onPointerMove, ...props }: LiquidGlassProps) {
  const handleMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      onPointerMove?.(e)
      if (!interactive) return
      const r = e.currentTarget.getBoundingClientRect()
      e.currentTarget.style.setProperty('--lg-x', `${((e.clientX - r.left) / r.width) * 100}%`)
      e.currentTarget.style.setProperty('--lg-y', `${((e.clientY - r.top) / r.height) * 100}%`)
    },
    [interactive, onPointerMove]
  )

  return (
    <div
      data-slot="liquid-glass"
      data-variant={variant}
      className={cn('liquid-glass', variant === 'clear' && 'lg-clear', tint && 'lg-tint', interactive && 'lg-interactive', thick && 'lg-thick', className)}
      onPointerMove={handleMove}
      {...props}
    />
  )
}
