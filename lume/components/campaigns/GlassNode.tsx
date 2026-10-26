'use client'

import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { FlowStage } from '@/lib/campaigns/types'
import { cn } from '@/lib/utils'

export type GlassNodeData = {
  stage: FlowStage
  busy: boolean
  onRun: (stage: FlowStage) => void
}
export type GlassFlowNode = Node<GlassNodeData, 'glass'>

const DOT: Record<FlowStage['status'], string> = {
  idle: 'bg-fg-24',
  waiting: 'bg-amber animate-pulse',
  active: 'bg-cyan animate-pulse',
  done: 'bg-green',
}

const fmt = new Intl.NumberFormat('en-US')

/** One Flow stage: glass panel, live count, status dot, and its Run button. */
function GlassNodeImpl({ data }: NodeProps<GlassFlowNode>) {
  const { stage, busy, onRun } = data
  const a = stage.action
  const disabled = a.type === 'disabled' || busy
  return (
    <div className="surface-card w-[150px] rounded-xl px-3 py-2.5 text-fg">
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-white/30" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium">{stage.label}</span>
        <span className={cn('size-2 rounded-full', DOT[stage.status])} aria-label={stage.status} />
      </div>
      <p className="mt-1 font-mono text-[20px] font-semibold tabular-nums">{stage.count === null ? '—' : fmt.format(stage.count)}</p>
      <p className="h-4 truncate text-[10px] text-fg-46" title={stage.hint ?? undefined}>
        {stage.hint ?? ''}
      </p>
      <button
        type="button"
        disabled={disabled}
        title={a.type === 'disabled' ? a.reason : undefined}
        onClick={() => onRun(stage)}
        className={cn(
          'nodrag mt-2 w-full rounded-md border px-2 py-1 text-[11px] transition-colors',
          disabled ? 'cursor-not-allowed border-white/6 text-fg-24' : 'border-violet/40 bg-violet/15 text-violet-soft hover:bg-violet/25'
        )}
      >
        {a.label}
      </button>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-white/30" />
    </div>
  )
}

export const GlassNode = memo(GlassNodeImpl)
