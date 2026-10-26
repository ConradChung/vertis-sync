import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Hand-written stand-in for @glasscn/glass-card (registry not reachable).
 *
 * A panel that carries `data-slot="card"` so shadcn's CardHeader / CardTitle /
 * CardDescription / CardContent / CardFooter compose inside it unchanged. Uses
 * the panel radius (16 px) and the prototype's 18 px internal padding.
 *
 * Liquid Glass rule: content never sits on glass. The default `surface`
 * variant is a calm translucent fill for the content layer (cards, tables,
 * KPI tiles). `glass` is only for a card that genuinely floats above content
 * (e.g. a standalone panel over the backdrop) — prefer `LiquidGlass` for
 * nav and controls.
 */
function GlassCard({
  className,
  size = 'default',
  variant = 'surface',
  ...props
}: React.ComponentProps<'div'> & { size?: 'default' | 'sm'; variant?: 'surface' | 'glass' }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-variant={variant}
      className={cn(
        'group/card relative flex flex-col gap-(--card-spacing) overflow-hidden rounded-panel py-(--card-spacing) text-sm text-fg [--card-spacing:18px] data-[size=sm]:[--card-spacing:14px]',
        variant === 'glass' ? 'liquid-glass lg-thick' : 'surface-card',
        className
      )}
      {...props}
    />
  )
}

export { GlassCard }
