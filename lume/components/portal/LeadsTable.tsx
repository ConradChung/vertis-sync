import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { PortalLead } from '@/lib/portal/types'
import { EngagementMarks, LeadLinks, LocalTimeLabel, PhoneLink, ReplyBadge } from './LeadBits'

/** Desktop: one dense row per lead. */
export function LeadsTable({ rows, now }: { rows: PortalLead[]; now: Date }) {
  return (
    <Table className="text-[13px]">
      <TableHeader className="[&_tr]:border-(--line)">
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4 text-[11px] font-medium tracking-wide text-fg-46 uppercase">Name</TableHead>
          <TableHead className="text-[11px] font-medium tracking-wide text-fg-46 uppercase">Company</TableHead>
          <TableHead className="text-[11px] font-medium tracking-wide text-fg-46 uppercase">Phone</TableHead>
          <TableHead className="text-[11px] font-medium tracking-wide text-fg-46 uppercase">Local time</TableHead>
          <TableHead className="text-[11px] font-medium tracking-wide text-fg-46 uppercase">Region · campaign</TableHead>
          <TableHead className="text-[11px] font-medium tracking-wide text-fg-46 uppercase">Status</TableHead>
          <TableHead className="pr-4 text-right text-[11px] font-medium tracking-wide text-fg-46 uppercase">Links</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((l) => (
          <TableRow key={`${l.kind}:${l.id}`} className="border-(--line) align-top hover:bg-secondary/60">
            <TableCell className="max-w-64 pl-4 whitespace-normal">
              <div className="font-medium text-fg">{l.name}</div>
              {l.title && <div className="text-[12px] text-fg-46">{l.title}</div>}
            </TableCell>
            <TableCell className="max-w-56 whitespace-normal text-fg-70">{l.company ?? '—'}</TableCell>
            <TableCell className="-ml-2">
              <PhoneLink lead={l} size="sm" />
            </TableCell>
            <TableCell className="max-w-56">
              <LocalTimeLabel lead={l} now={now} className="max-w-56" />
            </TableCell>
            <TableCell className="max-w-56 whitespace-normal">
              <div className="text-fg-70">{l.region ?? '—'}</div>
              {l.campaign && <div className="truncate text-[12px] text-fg-46">{l.campaign}</div>}
            </TableCell>
            <TableCell>
              <div className="flex flex-col items-start gap-1">
                <ReplyBadge status={l.reply_status} />
                <EngagementMarks lead={l} />
                {!l.reply_status && !l.opened && !l.replied && <span className="text-fg-24">—</span>}
              </div>
            </TableCell>
            <TableCell className="pr-4">
              <div className="flex justify-end">
                <LeadLinks lead={l} compact />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
