import { statusLabel, statusTone, type StatusTone } from '@/lib/import/format'
import { cn } from '@/lib/utils'

const TONE: Record<StatusTone, string> = {
  wait: 'bg-amber/12 text-amber border-amber/25',
  run: 'bg-violet/12 text-violet-soft border-violet/25',
  ok: 'bg-green/12 text-green border-green/25',
  bad: 'bg-red/12 text-red border-red/25',
  idle: 'bg-white/[.04] text-fg-46 border-line',
}

export function StatusBadge({ status, className }: { status: string | null; className?: string }) {
  const tone = statusTone(status)
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium whitespace-nowrap capitalize',
        TONE[tone],
        className
      )}
    >
      {statusLabel(status)}
    </span>
  )
}
