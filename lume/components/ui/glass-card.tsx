import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Lume's card: the `.glass` recipe (blur + translucent fill + translucent
 * border + inner top highlight), same as shadcn's Card. Carries
 * `data-slot="card"` so CardHeader / CardTitle / CardContent compose inside it.
 * `variant` is accepted for old call sites and ignored.
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
        'group/card relative flex flex-col gap-(--card-spacing) glass overflow-hidden rounded-xl py-(--card-spacing) text-sm text-card-foreground [--card-spacing:20px] data-[size=sm]:[--card-spacing:14px]',
        className
      )}
      {...props}
    />
  )
}

export { GlassCard }
