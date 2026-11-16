import { cn } from '@/lib/utils'
import type { PortalLead } from '@/lib/portal/types'
import { EngagementMarks, LeadLinks, LocalTimeLabel, PhoneLink, ReplyBadge } from './LeadBits'

/** A lead as a phone card: who, a big tap-to-call, their local time, and links. Also used under assistant replies. */
export function LeadCard({ lead, now, className }: { lead: PortalLead; now: Date; className?: string }) {
  const sub = [lead.title, lead.company].filter(Boolean).join(' · ')
  return (
    <article className={cn('glass flex min-w-0 flex-col gap-3 rounded-2xl p-4', className)} aria-label={lead.name}>
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[16px] leading-tight font-semibold text-fg">{lead.name}</h3>
          {sub && <p className="mt-0.5 line-clamp-2 text-[13px] text-fg-70">{sub}</p>}
        </div>
        <ReplyBadge status={lead.reply_status} />
      </header>
      <PhoneLink lead={lead} size="lg" />
      <div className="flex min-w-0 items-center justify-between gap-2 text-[13px]">
        <LocalTimeLabel lead={lead} now={now} className="min-w-0" />
        <LeadLinks lead={lead} />
      </div>
      {(lead.campaign || lead.region || lead.opened || lead.replied) && (
        <footer className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-46">
          {lead.region && <span>{lead.region}</span>}
          {lead.campaign && <span className="min-w-0 truncate">{lead.campaign}</span>}
          <EngagementMarks lead={lead} />
        </footer>
      )}
    </article>
  )
}
