import { Building2, Globe, Mail, Phone } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortalLead, PortalReplyStatus } from '@/lib/portal/types'
import { REPLY_TONE, displayHost, displayPhone, externalHref, localTime, locationLine, mailHref, phoneHref } from './format'
import { zoneFor } from './zones'

/**
 * Tap-to-call. `size="lg"` is the phone-card pill (48 px tall); `sm` sits in a
 * table cell. A company switchboard gets a small building icon (with a
 * tooltip naming who to ask for) instead of a line of text under every number.
 */
export function PhoneLink({ lead, size = 'lg', className }: { lead: Pick<PortalLead, 'phone' | 'phone_type' | 'first_name' | 'name'>; size?: 'lg' | 'sm'; className?: string }) {
  const href = phoneHref(lead.phone)
  if (!lead.phone || !href) return <span className={cn('text-[13px] text-fg-24', className)}>No phone</span>
  const company = lead.phone_type === 'company'
  const who = lead.first_name || lead.name
  const shown = displayPhone(lead.phone)
  return (
    <a
      href={href}
      aria-label={`Call ${lead.name} at ${shown}${company ? ' (company line)' : ''}`}
      title={company ? `Company line — ask for ${who}` : undefined}
      className={cn(
        'inline-flex items-center gap-2 rounded-xl font-mono font-medium whitespace-nowrap tabular-nums text-fg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        size === 'lg'
          ? 'h-12 w-full justify-center bg-primary/12 px-4 text-[17px] ring-1 ring-primary/25 ring-inset active:bg-primary/20 light:bg-primary/30 light:ring-(--lime-edge)'
          : 'h-8 w-fit px-2 text-[13px] hover:bg-secondary',
        className
      )}
    >
      <Phone className={cn('shrink-0 text-positive', size === 'lg' ? 'size-[18px]' : 'size-3.5')} strokeWidth={2} aria-hidden />
      {shown}
      {company && <Building2 data-testid="company-line" className={cn('shrink-0 text-fg-46', size === 'lg' ? 'size-4' : 'size-3.5')} strokeWidth={1.75} aria-hidden />}
    </a>
  )
}

/**
 * "9:41 AM" in the lead's zone (its own, or one derived from country/state)
 * with a business-hours dot. `withPlace` appends the location; without a zone
 * the location (or a dash) stands in.
 */
export function LocalTimeLabel({
  lead,
  now,
  withPlace = true,
  className,
}: {
  lead: Pick<PortalLead, 'timezone' | 'city' | 'state' | 'country' | 'region'>
  now: Date
  withPlace?: boolean
  className?: string
}) {
  const lt = localTime(zoneFor(lead), now)
  const place = withPlace ? locationLine(lead) : null
  if (!lt) return <span className={cn('truncate text-fg-46', className)}>{withPlace ? (place ?? '—') : '—'}</span>
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap', className)} title={lt.business ? 'Business hours there' : 'Outside business hours there'}>
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', lt.business ? 'bg-positive shadow-(--dot-glow) text-positive' : 'bg-fg-24')} />
      <span className={cn('tabular-nums', lt.business ? 'text-fg' : 'text-fg-46')}>{lt.time}</span>
      <span className="sr-only">{lt.business ? '(business hours)' : '(outside business hours)'}</span>
      {place && <span className="truncate text-fg-46">· {place}</span>}
    </span>
  )
}

export function ReplyBadge({ status }: { status: PortalReplyStatus | null }) {
  if (!status) return null
  const strong = REPLY_TONE[status] === 'strong'
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap',
        strong ? 'bg-primary text-primary-foreground ring-1 ring-(--lime-edge) ring-inset' : 'bg-primary/12 text-positive light:bg-primary/25 light:text-fg'
      )}
    >
      {status}
    </span>
  )
}

/** Small muted "Opened" / "Replied" markers. */
export function EngagementMarks({ lead }: { lead: Pick<PortalLead, 'opened' | 'replied'> }) {
  if (!lead.opened && !lead.replied) return null
  return (
    <span className="inline-flex items-center gap-2 text-[11px] text-fg-46">
      {lead.opened && <span>Opened</span>}
      {lead.replied && <span>Replied</span>}
    </span>
  )
}

const linkCls =
  'grid shrink-0 place-items-center rounded-xl text-fg-70 outline-none transition-colors hover:bg-secondary hover:text-fg focus-visible:ring-2 focus-visible:ring-ring'

/** Email / website / LinkedIn as icon links (44 px targets on phones, 32 px in the table). */
export function LeadLinks({ lead, compact = false }: { lead: Pick<PortalLead, 'email' | 'website' | 'linkedin_url' | 'name'>; compact?: boolean }) {
  const mail = mailHref(lead.email)
  const site = externalHref(lead.website)
  const li = externalHref(lead.linkedin_url)
  if (!mail && !site && !li) return null
  const size = compact ? 'size-8' : 'size-11'
  return (
    <div className="flex items-center gap-0.5">
      {mail && (
        <a href={mail} className={cn(linkCls, size)} aria-label={`Email ${lead.name}`} title={lead.email ?? undefined}>
          <Mail className="size-4" strokeWidth={1.75} aria-hidden />
        </a>
      )}
      {site && (
        <a
          href={site}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(linkCls, size)}
          aria-label={`Website ${displayHost(lead.website) ?? ''}`.trim()}
          title={displayHost(lead.website) ?? undefined}
        >
          <Globe className="size-4" strokeWidth={1.75} aria-hidden />
        </a>
      )}
      {li && (
        <a href={li} target="_blank" rel="noopener noreferrer" className={cn(linkCls, size)} aria-label={`LinkedIn profile of ${lead.name}`} title="LinkedIn">
          <span aria-hidden className="grid size-4 place-items-center rounded-[4px] border border-current text-[9px] leading-none font-bold">
            in
          </span>
        </a>
      )}
    </div>
  )
}
