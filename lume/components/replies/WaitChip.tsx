import { Clock } from 'lucide-react'
import { waitingOf } from '@/lib/replies/waiting'
import { cn } from '@/lib/utils'

/**
 * How long a row has waited. Plain grey text until it passes 5 minutes;
 * then it takes the accent fill, the one high-signal status on the page.
 */
export function WaitChip({ since, now, className }: { since: string; now: Date | number; className?: string }) {
  const w = waitingOf(since, now)
  return (
    <span
      data-wait
      data-overdue={w.overdue ? '1' : undefined}
      title={w.overdue ? 'Waiting over 5 minutes' : 'Waiting'}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 font-mono text-[12px] tabular-nums',
        w.overdue ? 'rounded-full bg-primary px-2 font-medium text-primary-foreground' : 'text-fg-46',
        className
      )}
    >
      <Clock className="size-3" strokeWidth={w.overdue ? 2 : 1.75} aria-hidden />
      {w.label}
      {w.overdue && <span className="sr-only"> — over 5 minutes</span>}
    </span>
  )
}
