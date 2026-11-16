import { cn } from '@/lib/utils'
import type { PortalLead } from '@/lib/portal/types'
import { EngagementMarks, LeadLinks, LocalTimeLabel, PhoneLink, ReplyBadge } from './LeadBits'
import { locationLine } from './format'

const th =
  'h-10 bg-(--surface) px-2 text-left align-middle text-[11px] font-medium tracking-wide whitespace-nowrap text-fg-46 uppercase backdrop-blur-xl shadow-[inset_0_-1px_0_0_var(--line)]'
const td = 'px-2 py-2 align-middle'

/**
 * Desktop: one compact row per lead. A plain `<table>` (no scrolling wrapper)
 * so the column header can stick to the page, or to the expanded view's
 * scroller; `stickyTop` is the offset it sticks at.
 */
export function LeadsTable({ rows, now, stickyTop = 'top-0' }: { rows: PortalLead[]; now: Date; stickyTop?: string }) {
  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
      <colgroup>
        <col className="w-[21%]" />
        <col className="w-[17%]" />
        <col className="w-[200px]" />
        <col className="w-[104px]" />
        <col className="w-[20%]" />
        <col className="w-[12%]" />
        <col className="w-[116px]" />
      </colgroup>
      <thead className={cn('sticky z-10 bg-(--bg) shadow-[0_1px_0_var(--line)]', stickyTop)}>
        <tr>
          <th className={cn(th, 'pl-4')}>Name</th>
          <th className={th}>Company</th>
          <th className={cn(th, 'pl-4')}>Phone</th>
          <th className={th}>Local time</th>
          <th className={th}>Location · campaign</th>
          <th className={th}>Status</th>
          <th className={cn(th, 'pr-4 text-right')}>Links</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => {
          const place = locationLine(l)
          return (
            <tr key={`${l.kind}:${l.id}`} className="transition-colors hover:bg-secondary/60 [&>td]:border-b [&>td]:border-(--line) last:[&>td]:border-b-0">
              <td className={cn(td, 'pl-4')}>
                <div className="truncate font-medium text-fg" title={l.name}>
                  {l.name}
                </div>
                {l.title && (
                  <div className="truncate text-[12px] text-fg-46" title={l.title}>
                    {l.title}
                  </div>
                )}
              </td>
              <td className={cn(td, 'truncate text-fg-70')} title={l.company ?? undefined}>
                {l.company ?? '—'}
              </td>
              <td className={td}>
                <PhoneLink lead={l} size="sm" />
              </td>
              <td className={td}>
                <LocalTimeLabel lead={l} now={now} withPlace={false} />
              </td>
              <td className={td}>
                <div className={cn('truncate', place ? 'text-fg-70' : 'text-fg-24')} title={place ?? undefined}>
                  {place ?? '—'}
                </div>
                {l.campaign && (
                  <div className="truncate text-[12px] text-fg-46" title={l.campaign}>
                    {l.campaign}
                  </div>
                )}
              </td>
              <td className={td}>
                <div className="flex flex-col items-start gap-1">
                  <ReplyBadge status={l.reply_status} />
                  <EngagementMarks lead={l} />
                  {!l.reply_status && !l.opened && !l.replied && <span className="text-fg-24">—</span>}
                </div>
              </td>
              <td className={cn(td, 'pr-4')}>
                <div className="flex justify-end">
                  <LeadLinks lead={l} compact />
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
