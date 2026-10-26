'use client'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { initials, relShort } from '@/lib/crm/client'
import { cn } from '@/lib/utils'

/** Small shared CRM pieces: avatar initials, source / stage / campaign badges, mono relative time. */

export function LeadAvatar({ name, email, className }: { name: string | null; email: string; className?: string }) {
  return (
    <Avatar className={cn('size-7 shrink-0', className)}>
      <AvatarFallback className="bg-secondary font-mono text-[10px] text-foreground">{initials(name, email)}</AvatarFallback>
    </Avatar>
  )
}

export function SourceBadge({ source }: { source: string }) {
  return (
    <Badge variant="outline" className="h-5 rounded-full border-border bg-(--glass-fill) px-2 font-mono text-[10px] font-normal text-muted-foreground lowercase">
      {source}
    </Badge>
  )
}

const CLOSED_GOOD = new Set(['Won', 'Meeting booked', 'Interested'])
const CLOSED_BAD = new Set(['Lost', 'Bounced'])

export function StageBadge({ stage, className }: { stage: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-5 rounded-full px-2 text-[11px] font-normal whitespace-nowrap',
        CLOSED_GOOD.has(stage) && 'border-transparent bg-primary/15 text-foreground dark:text-primary',
        CLOSED_BAD.has(stage) && 'border-transparent bg-destructive/10 text-destructive',
        !CLOSED_GOOD.has(stage) && !CLOSED_BAD.has(stage) && 'border-border bg-(--glass-fill) text-muted-foreground',
        className
      )}
    >
      {stage}
    </Badge>
  )
}

export function CampaignBadge({ name }: { name: string }) {
  return (
    <Badge variant="outline" className="h-5 max-w-[160px] rounded-full border-border bg-(--glass-fill) px-2 text-[10px] font-normal text-muted-foreground">
      <span className="truncate">{name}</span>
    </Badge>
  )
}

export function RelTime({ iso, now, className }: { iso: string | null; now?: number; className?: string }) {
  return (
    <time dateTime={iso ?? undefined} title={iso ? new Date(iso).toLocaleString() : undefined} className={cn('font-mono text-[11px] text-muted-foreground tabular-nums', className)}>
      {relShort(iso, now)}
    </time>
  )
}
