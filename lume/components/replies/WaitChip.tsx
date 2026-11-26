import { Clock } from 'lucide-react'
import { waitingOf } from '@/lib/replies/waiting'
import { cn } from '@/lib/utils'

/** How long a row has waited; filled with the attention colour once past 60 minutes. */
export function WaitChip({ since, now, className }: { since: string; now: Date | number; className?: string }) {
  const w = waitingOf(since, now)
  return (
    <span
      data-wait
      data-overdue={w.overdue ? '1' : undefined}
      title={w.overdue ? 'Waiting over an hour' : 'Waiting'}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 font-mono text-[11.5px] tabular-nums',
        w.overdue ? 'bg-amber text-black' : 'bg-secondary text-fg-70',
        className
      )}
    >
      <Clock className="size-3" strokeWidth={1.75} aria-hidden />
      {w.label}
      {w.overdue && <span className="sr-only"> — over an hour</span>}
    </span>
  )
}
