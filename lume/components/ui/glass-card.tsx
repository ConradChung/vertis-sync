import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Legacy name for Lume's flat card. Renders exactly like shadcn's Card
 * (`rounded-lg border bg-card`, no shadow, no blur) and carries
 * `data-slot="card"` so CardHeader / CardTitle / CardContent compose inside it.
 * `variant` is accepted for old call sites and ignored — every card is flat.
 */
function GlassCard({
  className,
  size = 'default',
  variant: _variant,
  ...props
}: React.ComponentProps<'div'> & { size?: 'default' | 'sm'; variant?: 'surface' | 'glass' }) {
  void _variant
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        'group/card relative flex flex-col gap-(--card-spacing) overflow-hidden rounded-lg border bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:20px] data-[size=sm]:[--card-spacing:14px]',
        className
      )}
      {...props}
    />
  )
}

export { GlassCard }
