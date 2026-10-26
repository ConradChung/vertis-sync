'use client'

import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Check, Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { FlowStage } from '@/lib/campaigns/types'
import { cn } from '@/lib/utils'

export type GlassNodeData = {
  stage: FlowStage
  busy: boolean
  onRun: (stage: FlowStage) => void
}
export type GlassFlowNode = Node<GlassNodeData, 'glass'>

const fmt = new Intl.NumberFormat('en-US')

/**
 * Node treatment by status: done = lit (lime edge, lime check badge);
 * active / waiting = the current stage (lime ring + pulse); idle = muted;
 * unused = dashed and faded (this path doesn't feed the campaign).
 * `--chart-line` is lime on dark and the deeper #5C8000 on light, so the
 * edge reads on both backgrounds.
 */
export const NODE_TONE: Record<FlowStage['status'], string> = {
  done: 'border-(--chart-line) bg-lime/[.07]',
  active: 'border-(--chart-line) bg-lime/[.10] ring-2 ring-(--chart-line)/45 shadow-(--primary-glow)',
  waiting: 'border-(--chart-line) bg-lime/[.10] ring-2 ring-(--chart-line)/45 shadow-(--primary-glow)',
  idle: 'border-border opacity-70',
  unused: 'border-dashed border-border opacity-45',
}

export function StatusBadge({ status }: { status: FlowStage['status'] }) {
  if (status === 'done')
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-lime text-[#0F1A12]" aria-label="done">
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    )
  if (status === 'active' || status === 'waiting')
    return (
      <span className="relative flex size-3" aria-label={status === 'waiting' ? 'waiting for you' : 'running'}>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-lime opacity-60" />
        <span className="relative inline-flex size-3 rounded-full bg-lime" />
      </span>
    )
  return <span className={cn('size-2 rounded-full', status === 'unused' ? 'border border-fg-24' : 'bg-fg-24')} aria-label={status} />
}

export function SourceInfo({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" className="nodrag text-fg-46 hover:text-fg" aria-label={`Where ${label} comes from`} />}
      >
        <Info className="size-3" />
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-[11px] leading-snug">{text}</TooltipContent>
    </Tooltip>
  )
}

/** One Flow stage: glass panel, live count, status, source tooltip, and its Run button. */
function GlassNodeImpl({ data }: NodeProps<GlassFlowNode>) {
  const { stage, busy, onRun } = data
  const a = stage.action
  const disabled = a.type === 'disabled' || busy
  const lit = stage.status === 'done' || stage.status === 'active' || stage.status === 'waiting'
  return (
    <div className={cn('surface-card w-[164px] rounded-xl border px-3 py-2.5 text-fg transition-colors', NODE_TONE[stage.status])}>
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-(--chart-line)/60" />
      <Handle id="bottom" type="target" position={Position.Bottom} className="!size-1.5 !border-0 !bg-(--chart-line)/60" />
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[12px] font-medium">
          {stage.label}
          <SourceInfo text={stage.source} label={stage.label} />
        </span>
        <StatusBadge status={stage.status} />
      </div>
      <p className={cn('mt-1 font-mono text-[20px] font-semibold tabular-nums', lit ? 'text-fg' : 'text-fg-46')}>
        {stage.count === null ? '—' : fmt.format(stage.count)}
      </p>
      <p className={cn('h-4 truncate text-[10px]', stage.status === 'done' ? 'text-positive' : 'text-fg-46')} title={stage.hint ?? undefined}>
        {stage.hint ?? ''}
      </p>
      <button
        type="button"
        disabled={disabled}
        title={a.type === 'disabled' ? a.reason : undefined}
        onClick={() => onRun(stage)}
        className={cn(
          'nodrag mt-2 w-full rounded-md border px-2 py-1 text-[11px] transition-colors',
          disabled ? 'cursor-not-allowed border-border text-fg-24' : 'border-primary/40 bg-accent text-fg hover:bg-primary/25'
        )}
      >
        {a.label}
      </button>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-(--chart-line)/60" />
    </div>
  )
}

export const GlassNode = memo(GlassNodeImpl)
