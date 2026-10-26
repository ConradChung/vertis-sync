'use client'

import { memo, useMemo, type CSSProperties } from 'react'
import { useTheme } from 'next-themes'
import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CalendarClock, Database, Flag, GitFork, Megaphone, StickyNote, Workflow, type LucideIcon } from 'lucide-react'
import { NODE_TONE, StatusBadge } from '@/components/campaigns/GlassNode'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { FlowStage } from '@/lib/campaigns/types'
import { placeDiagram, SPACING, type Diagram, type DiagramNode, type Direction } from '@/lib/agent/diagram'
import { cn } from '@/lib/utils'

export const NODE_W = 168

/** Diagram state → the Flow view's stage status (same lit / pulse / muted / dashed look). */
export const STATUS: Record<DiagramNode['state'], FlowStage['status']> = {
  done: 'done',
  current: 'active',
  planned: 'idle',
  skipped: 'unused',
}
const LIT = new Set<FlowStage['status']>(['done', 'active'])

export const KIND_ICON: Record<DiagramNode['kind'], LucideIcon> = {
  source: Database,
  step: Workflow,
  gate: GitFork,
  campaign: Megaphone,
  cron: CalendarClock,
  note: StickyNote,
}

type PipeData = { node: DiagramNode; direction: Direction; delay: number | null; hover: boolean }
export type PipeNode = Node<PipeData, 'pipe'>

function NodeBody({ n }: { n: DiagramNode }) {
  const status = STATUS[n.state]
  const Icon = n.kind === 'gate' && n.state === 'current' ? Flag : KIND_ICON[n.kind]
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium">
          <Icon className="size-3.5 shrink-0 text-fg-46" />
          <span className="truncate" title={n.label}>
            {n.label}
          </span>
        </span>
        <StatusBadge status={status} />
      </div>
      {n.detail && (
        <p className={cn('mt-1 line-clamp-2 text-[10.5px] leading-snug', status === 'done' ? 'text-positive' : 'text-fg-46')} title={n.detail}>
          {n.detail}
        </p>
      )}
      <p className="mt-1 text-[9.5px] tracking-wide text-fg-24 uppercase">{n.kind}</p>
    </>
  )
}

function PipeNodeImpl({ data }: NodeProps<PipeNode>) {
  const { node: n, direction, delay, hover } = data
  const status = STATUS[n.state]
  const tb = direction === 'TB'
  const handle = '!size-1.5 !border-0 !bg-(--chart-line)/60'
  const style: CSSProperties = { width: NODE_W, ...(delay !== null ? { animationDelay: `${delay}ms` } : {}) }
  const card = (
    <div className={cn('surface-card rounded-xl border px-3 py-2.5 text-fg', NODE_TONE[status], delay !== null && 'diagram-node-in')} style={style}>
      <Handle type="target" position={tb ? Position.Top : Position.Left} className={handle} />
      <NodeBody n={n} />
      <Handle type="source" position={tb ? Position.Bottom : Position.Right} className={handle} />
    </div>
  )
  if (!hover) return card
  return (
    <HoverCard>
      <HoverCardTrigger render={<div />} delay={150}>
        {card}
      </HoverCardTrigger>
      <HoverCardContent side="top" className="glass-overlay w-64 text-[12px] leading-snug">
        <p className="font-medium text-fg">{n.label}</p>
        <p className="mt-0.5 text-[10.5px] tracking-wide text-fg-46 uppercase">
          {n.kind} · {n.state}
        </p>
        {n.detail && <p className="mt-2 text-fg-70">{n.detail}</p>}
      </HoverCardContent>
    </HoverCard>
  )
}

export const pipeNodeTypes = { pipe: memo(PipeNodeImpl) }

function edgeStyle(from: FlowStage['status'], to: FlowStage['status']) {
  if (LIT.has(from) && LIT.has(to)) return { stroke: 'var(--chart-line)', strokeWidth: 2 }
  if (from === 'unused' || to === 'unused') return { stroke: 'var(--fg-24)', strokeDasharray: '4 4' }
  return { stroke: 'var(--fg-24)' }
}

export interface BuildOptions {
  direction?: Direction
  /** Stagger nodes by rank and draw edges in (respecting reduced motion via CSS). */
  animate?: boolean
  /** Hover cards with each node's detail (Playground). */
  hover?: boolean
}

/** React Flow nodes + edges for a diagram, laid out in a direction. */
export function buildFlow(diagram: Diagram, { direction = 'LR', animate = false, hover = false }: BuildOptions = {}) {
  const { placed, ranks, breadth } = placeDiagram(diagram, direction)
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]))
  const rankOf = new Map(placed.map((p) => [p.id, p.rank]))
  const nodes: PipeNode[] = placed.map((p) => ({
    id: p.id,
    type: 'pipe',
    position: { x: p.x, y: p.y },
    data: { node: byId.get(p.id)!, direction, delay: animate ? 120 + p.rank * 90 : null, hover },
    draggable: false,
    selectable: false,
  }))
  const edges: Edge[] = diagram.edges.map((e, i) => {
    const from = STATUS[byId.get(e.from)!.state]
    const to = STATUS[byId.get(e.to)!.state]
    const style = edgeStyle(from, to)
    const animated = to === 'active'
    const drawable = !animated && !('strokeDasharray' in style)
    return {
      id: `${e.from}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      animated,
      style,
      ...(animate
        ? { className: cn(drawable ? 'diagram-edge-draw' : 'diagram-edge-fade', `diagram-d-${Math.min(15, rankOf.get(e.to) ?? 0)}`) }
        : {}),
      ...(e.label
        ? {
            label: e.label,
            labelStyle: { fill: 'var(--fg-70)', fontSize: 10 },
            labelBgStyle: { fill: 'var(--glass-fill-strong)' },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 4,
          }
        : {}),
    }
  })
  return { nodes, edges, ranks, breadth }
}

/** Canvas size for a static (non-interactive) diagram. */
export function staticSize(direction: Direction, ranks: number, breadth: number) {
  const s = SPACING[direction]
  return direction === 'TB'
    ? { height: Math.min(760, 40 + ranks * s.rank), minWidth: Math.min(breadth * s.cross, 720) }
    : { height: Math.min(520, 70 + breadth * s.cross), minWidth: Math.min(Math.round(ranks * s.rank * 0.62), 900) }
}

export function DiagramLegend({ className }: { className?: string }) {
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-46', className)} aria-label="Legend">
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-lime" /> done</li>
      <li className="flex items-center gap-1.5"><span className="size-2.5 animate-pulse rounded-full bg-lime ring-2 ring-lime/40" /> current</li>
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-fg-24" /> planned</li>
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-dashed border-fg-46" /> skipped</li>
    </ul>
  )
}

/**
 * A read-only pipeline (agent ```flow fence) in the Campaigns Flow look:
 * done = lit lime + check, current = ring + pulse, planned = muted, skipped =
 * dashed. TB in the chat card (branches spread sideways), LR elsewhere.
 */
export function PipelineDiagram({ diagram, direction = 'LR', animate = false, className }: { diagram: Diagram; direction?: Direction; animate?: boolean; className?: string }) {
  const { resolvedTheme } = useTheme()
  const { nodes, edges, size } = useMemo(() => {
    const f = buildFlow(diagram, { direction, animate })
    return { ...f, size: staticSize(direction, f.ranks, f.breadth) }
  }, [diagram, direction, animate])

  return (
    <div className={cn('overflow-x-auto', className)} aria-label={diagram.title ? `Pipeline diagram: ${diagram.title}` : 'Pipeline diagram'} role="figure">
      {/* Fits the card (fitView); scrolls sideways on phones when the diagram is wide. */}
      <div style={{ height: size.height, minWidth: size.minWidth }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={pipeNodeTypes}
          fitView
          fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
          minZoom={0.3}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          panOnScroll={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
          colorMode={resolvedTheme === 'light' ? 'light' : 'dark'}
          style={{ background: 'transparent' }}
        />
      </div>
    </div>
  )
}
