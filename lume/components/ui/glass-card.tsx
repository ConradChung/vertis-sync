import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Hand-written stand-in for @glasscn/glass-card (registry not reachable).
 *
 * A panel with the `.glass` recipe from DESIGN.md. It carries
 * `data-slot="card"` so shadcn's CardHeader / CardTitle / CardDescription /
 * CardContent / CardFooter compose inside it unchanged. Uses the panel radius
 * (16 px) and the prototype's 18 px internal padding.
 */
function GlassCard({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<'div'> & { size?: 'default' | 'sm' }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        'group/card glass relative flex flex-col gap-(--card-spacing) overflow-hidden rounded-panel py-(--card-spacing) text-sm text-fg [--card-spacing:18px] data-[size=sm]:[--card-spacing:14px]',
        className
      )}
      {...props}
    />
  )
}

export { GlassCard }
