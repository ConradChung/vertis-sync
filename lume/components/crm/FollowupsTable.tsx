'use client'

import { Check, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SectionTitle } from '@/components/overview/parts'
import { CampaignBadge, LeadAvatar, RelTime, StageBadge } from '@/components/crm/parts'
import type { CrmDealCard } from '@/lib/crm/types'

/**
 * Bottom table: deals whose next action is past due (the view the
 * `crm-followup-tick` cron flags). Done clears the next action; Snooze
 * moves it to tomorrow 9:00 local.
 */
export function FollowupsTable({
  rows,
  showCampaign,
  campaignName,
  busyId,
  onOpen,
  onDone,
  onSnooze,
}: {
  rows: CrmDealCard[]
  showCampaign: boolean
  campaignName: (id: string) => string
  busyId: string | null
  onOpen: (d: CrmDealCard) => void
  onDone: (d: CrmDealCard) => void
  onSnooze: (d: CrmDealCard) => void
}) {
  return (
    <GlassCard className="gap-0 py-0" aria-label="Follow-ups due">
      <SectionTitle title="Follow-ups due">
        <span className="font-mono tabular-nums">{rows.length}</span>
      </SectionTitle>
      {rows.length === 0 ? (
        <p className="px-5 pt-1 pb-5 text-sm text-muted-foreground">Nothing overdue. Set a next action on a lead and it shows up here when it comes due.</p>
      ) : (
        <Table>
          <TableHeader className="bg-(--glass-fill)">
            <TableRow className="hover:bg-transparent">
              {['Lead', 'Stage', 'Last touch', 'Next action', 'Owner', ''].map((h, i) => (
                <TableHead key={i} className="h-8 text-xs font-normal text-muted-foreground first:pl-5 last:pr-5">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id} className="hover:bg-accent" data-testid="crm-followup-row">
                <TableCell className="py-2 pl-5">
                  <button type="button" onClick={() => onOpen(d)} className="flex min-w-0 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <LeadAvatar name={d.name} email={d.email} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-foreground">{d.name ?? d.email}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{d.email}</span>
                    </span>
                    {showCampaign && <CampaignBadge name={campaignName(d.campaign_id)} />}
                  </button>
                </TableCell>
                <TableCell>
                  <StageBadge stage={d.stage} />
                </TableCell>
                <TableCell>
                  <RelTime iso={d.last_activity_at} />
                </TableCell>
                <TableCell className="max-w-[260px]">
                  <div className="truncate text-xs text-foreground">{d.next_action ?? 'Follow up'}</div>
                  <RelTime iso={d.next_action_at} className="text-destructive" />
                </TableCell>
                <TableCell className="text-muted-foreground">{d.owner ?? '—'}</TableCell>
                <TableCell className="pr-5 text-right whitespace-nowrap">
                  <Button size="sm" variant="outline" disabled={busyId === d.id} onClick={() => onDone(d)}>
                    <Check /> Done
                  </Button>{' '}
                  <Button size="sm" variant="ghost" disabled={busyId === d.id} onClick={() => onSnooze(d)}>
                    <Clock /> Snooze
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </GlassCard>
  )
}

/** Tomorrow 9:00 in the browser's zone, as ISO. */
export function tomorrowNine(now = new Date()): string {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.toISOString()
}
