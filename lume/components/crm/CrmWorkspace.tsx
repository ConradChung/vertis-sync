'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Columns3, Rows3, Search, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { GlassCard } from '@/components/ui/glass-card'
import { CloseDialog } from '@/components/crm/CloseDialog'
import { CrmBoard } from '@/components/crm/CrmBoard'
import { CrmRail } from '@/components/crm/CrmRail'
import { CrmTable } from '@/components/crm/CrmTable'
import { FollowupsTable, tomorrowNine } from '@/components/crm/FollowupsTable'
import { LeadSheet } from '@/components/crm/LeadSheet'
import { useCrmBoard } from '@/hooks/useCrm'
import { patchDeal, patchErrorText, type PatchBody } from '@/lib/crm/client'
import { requiresApproval } from '@/lib/crm/stages'
import type { CrmBoardResponse, CrmDealCard } from '@/lib/crm/types'

export const OPEN_PALETTE_EVENT = 'lume:open-palette'

type View = 'board' | 'table'

/**
 * The CRM console: breadcrumb + [Board|Table] + ⌘K (+ a campaign switcher on
 * the top-level page), a resizable left rail of stat tiles, the working area,
 * and the follow-ups-due table underneath. Used by the campaign CRM tab
 * (`campaignId` fixed) and by /crm (`switcher`, with an "All campaigns" board
 * that badges each card with its campaign).
 */
export function CrmWorkspace({
  campaignId,
  campaignLabel,
  switcher,
  onCampaignChange,
  crumbs,
  initialDealId,
}: {
  /** Open this deal's sheet on mount / when it changes (⌘K lead jump). */
  initialDealId?: string | null
  campaignId: string
  campaignLabel?: string
  switcher?: boolean
  onCampaignChange?: (id: string) => void
  crumbs: { label: string; href?: string }[]
}) {
  const board = useCrmBoard(campaignId)
  const [view, setView] = useState<View>('board')
  const [openId, setOpenId] = useState<string | null>(initialDealId ?? null)
  useEffect(() => {
    if (initialDealId) setOpenId(initialDealId)
  }, [initialDealId])
  const [closing, setClosing] = useState<{ deal: CrmDealCard; stage: 'Won' | 'Lost' } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const data = board.data
  const all = campaignId === 'all'

  const names = useMemo(() => new Map((data?.campaigns ?? []).map((c) => [c.id, c.name])), [data?.campaigns])
  const campaignName = useCallback((id: string) => names.get(id) ?? (id === campaignId && campaignLabel ? campaignLabel : id), [names, campaignId, campaignLabel])

  const send = useCallback(
    async (deal: CrmDealCard, body: PatchBody, okText?: string) => {
      setBusyId(deal.id)
      // Optimistic stage move for direct moves.
      if (body.stage && !requiresApproval(body.stage)) {
        void board.mutate(
          (cur) => (cur ? { ...cur, deals: cur.deals.map((d) => (d.id === deal.id ? { ...d, stage: body.stage! } : d)) } : cur),
          { revalidate: false }
        )
      }
      const a = await patchDeal(deal.id, body)
      setBusyId(null)
      if (a.status === 202) toast('Sent for approval', { description: 'The deal moves once you approve it in Telegram or Pending approvals.' })
      else if (a.status === 200) {
        if (okText) toast(okText)
      } else toast.error(patchErrorText(a))
      void board.mutate()
    },
    [board]
  )

  const onMove = useCallback(
    (deal: CrmDealCard, stage: string) => {
      if (requiresApproval(stage)) setClosing({ deal, stage })
      else void send(deal, { stage }, `${deal.name ?? deal.email} → ${stage}`)
    },
    [send]
  )

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((c, i) => (
            <span key={i} className="contents">
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {c.href ? <BreadcrumbLink render={<Link href={c.href} />}>{c.label}</BreadcrumbLink> : <BreadcrumbPage>{c.label}</BreadcrumbPage>}
              </BreadcrumbItem>
            </span>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {switcher && (
        <SimpleSelect
          aria-label="Campaign"
          size="sm"
          className="w-64"
          value={campaignId}
          onValueChange={(v) => onCampaignChange?.(v || 'all')}
          options={[{ value: 'all', label: 'All campaigns' }, ...(data?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name }))]}
        />
      )}
      <div className="ml-auto flex items-center gap-2">
        <ToggleGroup
          aria-label="View"
          variant="outline"
          size="sm"
          value={[view]}
          onValueChange={(v: unknown[]) => {
            const next = v[0]
            if (next === 'board' || next === 'table') setView(next)
          }}
        >
          <ToggleGroupItem value="board" aria-label="Board view">
            <Columns3 /> Board
          </ToggleGroupItem>
          <ToggleGroupItem value="table" aria-label="Table view">
            <Rows3 /> Table
          </ToggleGroupItem>
        </ToggleGroup>
        <Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))} aria-label="Open command palette">
          <Search /> <Kbd>⌘K</Kbd>
        </Button>
      </div>
    </div>
  )

  if (board.error && !data) {
    return (
      <div className="space-y-4">
        {header}
        <GlassCard className="px-5 text-sm text-muted-foreground" role="alert">
          <div className="flex items-center justify-between">
            <span>Couldn&apos;t load the pipeline.</span>
            <Button size="sm" variant="ghost" onClick={() => void board.mutate()}>
              Retry
            </Button>
          </div>
        </GlassCard>
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="crm-workspace">
      {header}
      {!data ? (
        <LoadingSkeleton />
      ) : (
        <>
          <ResizablePanelGroup orientation="horizontal" className="min-h-[520px] gap-0 max-md:flex-col">
            <ResizablePanel defaultSize={240} minSize={200} maxSize={380} className="max-md:w-full">
              <div className="h-full pr-3 max-md:pr-0 max-md:pb-3">
                <CrmRail data={data} />
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle className="max-md:hidden" />
            <ResizablePanel minSize="40" className="min-w-0">
              <div className="h-full min-w-0 pl-3 max-md:pl-0">
                {data.deals.length === 0 ? (
                  <NoDeals all={all} />
                ) : view === 'board' ? (
                  <CrmBoard
                    deals={data.deals}
                    stages={data.stages}
                    awaiting={data.awaiting_close}
                    showCampaign={all}
                    campaignName={campaignName}
                    onOpen={(d) => setOpenId(d.id)}
                    onMove={onMove}
                  />
                ) : (
                  <CrmTable
                    deals={data.deals}
                    stages={data.stages}
                    owners={data.owners}
                    showCampaign={all}
                    campaignName={campaignName}
                    onOpen={(d) => setOpenId(d.id)}
                  />
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
          <FollowupsTable
            rows={data.followups}
            showCampaign={all}
            campaignName={campaignName}
            busyId={busyId}
            onOpen={(d) => setOpenId(d.id)}
            onDone={(d) => void send(d, { next_action_at: null, next_action: null }, 'Follow-up done')}
            onSnooze={(d) => void send(d, { next_action_at: tomorrowNine() }, 'Snoozed to tomorrow 9:00')}
          />
        </>
      )}

      <LeadSheet dealId={openId} onOpenChange={(o) => !o && setOpenId(null)} onChanged={() => void board.mutate()} />
      <CloseDialog
        key={closing ? `${closing.deal.id}-${closing.stage}` : 'none'}
        target={closing ? { stage: closing.stage, label: closing.deal.name ?? closing.deal.email } : null}
        busy={busyId !== null}
        onCancel={() => setClosing(null)}
        onConfirm={(reason) => {
          const c = closing!
          setClosing(null)
          void send(c.deal, { stage: c.stage, reason })
        }}
      />
    </div>
  )
}

function NoDeals({ all }: { all: boolean }) {
  return (
    <Empty className="glass h-full min-h-[360px] rounded-xl border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Users strokeWidth={1.75} />
        </EmptyMedia>
        <EmptyTitle>No deals {all ? 'yet' : 'in this campaign yet'}</EmptyTitle>
        <EmptyDescription>
          Deals appear when Instantly reports a send, reply, interest or bounce for a lead. Leads already sent can be imported in one go once the CRM backfill is approved.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function LoadingSkeleton() {
  return (
    <div className="flex gap-6" aria-busy aria-label="Loading pipeline">
      <div className="w-[240px] shrink-0 space-y-2.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <div className="flex flex-1 gap-3 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[420px] w-[264px] shrink-0 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

export type { CrmBoardResponse }
