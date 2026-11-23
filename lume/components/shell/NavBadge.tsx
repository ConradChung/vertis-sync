import { badgeText } from '@/lib/approvals/view'
import { cn } from '@/lib/utils'

/** The pending-approvals count on a nav item; renders nothing at 0. */
export function NavBadge({ count, className }: { count: number | null | undefined; className?: string }) {
  const text = badgeText(count)
  if (!text) return null
  return (
    <span
      data-nav-badge
      className={cn('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber px-1 font-mono text-[10.5px] leading-none font-semibold text-black tabular-nums', className)}
    >
      {text}
      <span className="sr-only"> waiting for approval</span>
    </span>
  )
}
