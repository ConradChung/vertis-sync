'use client'

import { memo, useMemo } from 'react'
import { useTheme } from 'next-themes'
import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CalendarClock, Database, Flag, GitFork, Megaphone, StickyNote, Workflow, type LucideIcon } from 'lucide-react'
import { NODE_TONE, StatusBadge } from '@/components/campaigns/GlassNode'
import type { FlowStage } from '@/lib/campaigns/types'
import { layoutDiagram, type Diagram, type DiagramNode } from '@/lib/agent/diagram'
import { cn } from '@/lib/utils'

const COL = 200
const ROW = 104
const NODE_W = 168

/** Diagram state → the Flow view's stage status (same lit / pulse / muted / dashed look). */
const STATUS: Record<DiagramNode['state'], FlowStage['status']> = {
  done: 'done',
  current: 'active',
  planned: 'idle',
  skipped: 'unused',
}
const LIT = new Set<FlowStage['status']>(['done', 'active'])

const KIND_ICON: Record<DiagramNode['kind'], LucideIcon> = {
  source: Database,
  step: Workflow,
  gate: GitFork,
  campaign: Megaphone,
  cron: CalendarClock,
  note: StickyNote,
}

type PipeNode = Node<{ node: DiagramNode }, 'pipe'>

function PipeNodeImpl({ data }: NodeProps<PipeNode>) {
  const n = data.node
  const status = STATUS[n.state]
  const Icon = n.kind === 'gate' && n.state === 'current' ? Flag : KIND_ICON[n.kind]
  return (
    <div className={cn('surface-card rounded-xl border px-3 py-2.5 text-fg', NODE_TONE[status])} style={{ width: NODE_W }}>
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-(--chart-line)/60" />
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
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-(--chart-line)/60" />
    </div>
  )
}

const nodeTypes = { pipe: memo(PipeNodeImpl) }

function edgeStyle(from: FlowStage['status'], to: FlowStage['status']) {
  if (LIT.has(from) && LIT.has(to)) return { stroke: 'var(--chart-line)', strokeWidth: 2 }
  if (from === 'unused' || to === 'unused') return { stroke: 'var(--fg-24)', strokeDasharray: '4 4' }
  return { stroke: 'var(--fg-24)' }
}

/**
 * A pipeline drawn by the agent (```flow fence), in the Campaigns Flow look:
 * done = lit lime + check, current = ring + pulse, planned = muted, skipped =
 * dashed. Read-only; laid out left to right with branches spread vertically.
 */
export function PipelineDiagram({ diagram }: { diagram: Diagram }) {
  const { resolvedTheme } = useTheme()
  const { nodes, edges, width, height } = useMemo(() => {
    const placed = layoutDiagram(diagram)
    const byId = new Map(diagram.nodes.map((n) => [n.id, n]))
    const ranks = Math.max(...placed.map((p) => p.rank)) + 1
    const rows = new Map<number, number>()
    for (const p of placed) rows.set(p.rank, (rows.get(p.rank) ?? 0) + 1)
    const tallest = Math.max(...rows.values())
    const nodes: PipeNode[] = placed.map((p) => ({
      id: p.id,
      type: 'pipe',
      position: { x: p.rank * COL, y: p.row * ROW },
      data: { node: byId.get(p.id)! },
      draggable: false,
      selectable: false,
    }))
    const edges: Edge[] = diagram.edges.map((e, i) => {
      const from = STATUS[byId.get(e.from)!.state]
      const to = STATUS[byId.get(e.to)!.state]
      return {
        id: `${e.from}-${e.to}-${i}`,
        source: e.from,
        target: e.to,
        animated: to === 'active',
        style: edgeStyle(from, to),
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
    return { nodes, edges, width: ranks * COL, height: Math.min(520, 70 + tallest * ROW) }
  }, [diagram])

  return (
    <figure className="flex flex-col gap-2" aria-label={diagram.title ? `Pipeline diagram: ${diagram.title}` : 'Pipeline diagram'}>
      {diagram.title && <figcaption className="text-[12px] font-medium tracking-wide text-fg-70 uppercase">{diagram.title}</figcaption>}
      <div className="overflow-x-auto rounded-xl border border-border bg-(--glass-fill)">
        {/* Fits the panel on desktop (fitView zooms out a little); scrolls sideways on phones. */}
        <div style={{ height, minWidth: Math.min(Math.round(width * 0.62), 900) }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
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
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-46" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-lime" /> done</li>
        <li className="flex items-center gap-1.5"><span className="size-2.5 animate-pulse rounded-full bg-lime ring-2 ring-lime/40" /> current</li>
        <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-fg-24" /> planned</li>
        <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-dashed border-fg-46" /> skipped</li>
      </ul>
    </figure>
  )
}
