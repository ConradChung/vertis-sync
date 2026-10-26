'use client'

import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { Hourglass } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { CampaignBadge, LeadAvatar, RelTime, SourceBadge } from '@/components/crm/parts'
import { conversions, countByStage } from '@/lib/crm/stages'
import type { CrmDealCard, CrmStage } from '@/lib/crm/types'
import { cn } from '@/lib/utils'

/**
 * Board view: one column per stage (main line, then side exits). Header:
 * name, count badge, conversion % from the previous main-line stage. Cards
 * drag between columns; `onMove` decides what a drop does (Won/Lost ask for
 * a reason and approval; others apply directly).
 */
export function CrmBoard({
  deals,
  stages,
  awaiting,
  showCampaign,
  campaignName,
  onOpen,
  onMove,
}: {
  deals: CrmDealCard[]
  stages: CrmStage[]
  awaiting: Record<string, string>
  showCampaign: boolean
  campaignName: (id: string) => string
  onOpen: (deal: CrmDealCard) => void
  onMove: (deal: CrmDealCard, stage: string) => void
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor))
  const [dragging, setDragging] = useState<CrmDealCard | null>(null)
  const counts = countByStage(deals)
  const conv = conversions(stages, counts)
  const now = Date.now()

  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current?.deal as CrmDealCard) ?? null)
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    const deal = e.active.data.current?.deal as CrmDealCard | undefined
    const stage = e.over?.data.current?.stage as string | undefined
    if (deal && stage && stage !== deal.stage) onMove(deal, stage)
  }

  return (
    <DndContext id="crm-dnd" sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <ScrollArea className="w-full">
        <div className="flex gap-3 pb-3" role="list" aria-label="Pipeline board">
          {stages.map((s) => (
            <Column
              key={s.name}
              stage={s}
              count={counts[s.name] ?? 0}
              conversion={conv[s.name] ?? null}
              deals={deals.filter((d) => d.stage === s.name)}
              awaiting={awaiting}
              showCampaign={showCampaign}
              campaignName={campaignName}
              now={now}
              onOpen={onOpen}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <DragOverlay dropAnimation={null}>
        {dragging && <DealCard deal={dragging} awaiting={false} showCampaign={showCampaign} campaignName={campaignName} now={now} overlay />}
      </DragOverlay>
    </DndContext>
  )
}

const COLUMN_CAP = 150

function Column({
  stage,
  count,
  conversion,
  deals,
  awaiting,
  showCampaign,
  campaignName,
  now,
  onOpen,
}: {
  stage: CrmStage
  count: number
  conversion: number | null
  deals: CrmDealCard[]
  awaiting: Record<string, string>
  showCampaign: boolean
  campaignName: (id: string) => string
  now: number
  onOpen: (deal: CrmDealCard) => void
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `stage:${stage.name}`, data: { stage: stage.name } })
  const shown = deals.slice(0, COLUMN_CAP)
  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={`${stage.name}: ${count}`}
      data-testid="crm-column"
      className={cn(
        'glass flex w-[264px] shrink-0 flex-col overflow-hidden rounded-xl transition-colors',
        active && 'ring-1 ring-border',
        isOver && 'bg-accent ring-1 ring-ring'
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <h3 className="truncate text-sm font-medium text-foreground">{stage.name}</h3>
        <Badge variant="secondary" className="h-5 rounded-full px-1.5 font-mono text-[11px] tabular-nums">
          {count}
        </Badge>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums" title="Conversion from the previous stage">
          {conversion === null ? '' : `${conversion}%`}
        </span>
      </header>
      <div className="thin-scroll flex max-h-[560px] min-h-[120px] flex-col gap-2 overflow-y-auto p-2">
        {shown.map((d) => (
          <DraggableCard key={d.id} deal={d} awaiting={!!awaiting[d.id]} showCampaign={showCampaign} campaignName={campaignName} now={now} onOpen={onOpen} />
        ))}
        {deals.length > COLUMN_CAP && (
          <p className="px-1 py-2 text-center font-mono text-[11px] text-muted-foreground">+{deals.length - COLUMN_CAP} more — use Table view</p>
        )}
        {deals.length === 0 && <p className="px-1 py-6 text-center text-xs text-muted-foreground">Drop a card here</p>}
      </div>
    </section>
  )
}

function DraggableCard(props: { deal: CrmDealCard; awaiting: boolean; showCampaign: boolean; campaignName: (id: string) => string; now: number; onOpen: (d: CrmDealCard) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `deal:${props.deal.id}`, data: { deal: props.deal }, disabled: props.awaiting })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => props.onOpen(props.deal)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') props.onOpen(props.deal)
        listeners?.onKeyDown?.(e)
      }}
      className={cn('rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring', isDragging && 'opacity-40')}
      aria-label={`${props.deal.name ?? props.deal.email}, ${props.deal.company ?? ''}. Enter to open, space to move.`}
    >
      <DealCard {...props} />
    </div>
  )
}

export function DealCard({
  deal: d,
  awaiting,
  showCampaign,
  campaignName,
  now,
  overlay,
}: {
  deal: CrmDealCard
  awaiting: boolean
  showCampaign: boolean
  campaignName: (id: string) => string
  now: number
  overlay?: boolean
}) {
  return (
    <article
      data-testid="crm-card"
      className={cn(
        'flex cursor-grab flex-col gap-1.5 rounded-lg border border-border bg-(--glass-fill) p-2.5 text-left transition-colors hover:bg-accent active:cursor-grabbing',
        overlay && 'rotate-1 bg-popover shadow-lg backdrop-blur-xl'
      )}
    >
      <div className="flex items-center gap-2">
        <LeadAvatar name={d.name} email={d.email} className="size-6" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">{d.name ?? d.email}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {[d.company, d.city].filter(Boolean).join(' · ') || d.email}
          </div>
        </div>
        <RelTime iso={d.last_activity_at} now={now} className="shrink-0 text-[10px]" />
      </div>
      {d.snippet && <p className="line-clamp-1 text-[12px] text-muted-foreground">“{d.snippet}”</p>}
      <div className="flex flex-wrap items-center gap-1">
        <SourceBadge source={d.source} />
        {showCampaign && <CampaignBadge name={campaignName(d.campaign_id)} />}
        {awaiting && (
          <Badge variant="outline" className="h-5 gap-1 rounded-full border-border px-2 text-[10px] font-normal text-foreground">
            <Hourglass size={11} strokeWidth={1.75} aria-hidden /> Awaiting approval
          </Badge>
        )}
      </div>
    </article>
  )
}
