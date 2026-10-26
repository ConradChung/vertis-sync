'use client'

import { memo } from 'react'
import Link from 'next/link'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { CalendarClock } from 'lucide-react'
import { NODE_TONE, StatusBadge } from '@/components/campaigns/GlassNode'
import type { FlowFeeder } from '@/lib/campaigns/types'
import { cn } from '@/lib/utils'

export type FeederNodeData = { feeder: FlowFeeder }
export type FeederFlowNode = Node<FeederNodeData, 'feeder'>

const fmt = new Intl.NumberFormat('en-US')
const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const at = (iso: string | null) => (iso ? when.format(new Date(iso)) : '—')

/** A scheduled feeder on the branch: rotation rule or the instantly-rotate cron. Click → Rotate. */
function FeederNodeImpl({ data }: NodeProps<FeederFlowNode>) {
  const f = data.feeder
  const status = f.active ? (f.last_run ? 'done' : 'idle') : 'unused'
  return (
    <div className={cn('surface-card w-[236px] rounded-xl border px-3 py-2.5 text-fg', NODE_TONE[status])}>
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-(--chart-line)/60" />
      <div className="flex items-center justify-between gap-2">
        <Link href={f.href} className="nodrag flex min-w-0 items-center gap-1.5 text-[12px] font-medium hover:underline">
          <CalendarClock className="size-3.5 shrink-0 text-fg-46" />
          <span className="truncate">{f.name}</span>
        </Link>
        <span className="flex items-center gap-1.5 text-[10px] text-fg-46">
          {f.kind === 'rule' ? 'rule' : 'cron'}
          <StatusBadge status={status} />
        </span>
      </div>
      <p className="mt-1 text-[11px] text-fg-70">{f.active ? f.schedule : `Paused · ${f.schedule}`}</p>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px]">
        <dt className="text-fg-46">Next</dt>
        <dd className="truncate">{f.active ? at(f.next_run) : 'not scheduled'}</dd>
        <dt className="text-fg-46">Last</dt>
        <dd className="truncate" title={f.last_result}>
          {at(f.last_run)} · {f.last_result}
        </dd>
        <dt className="text-fg-46">Added</dt>
        <dd className={cn('truncate', f.leads_added ? 'text-positive' : '')}>
          {f.leads_added === null ? '—' : fmt.format(f.leads_added)} {f.leads_added_label}
        </dd>
      </dl>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-(--chart-line)/60" />
    </div>
  )
}

export const FeederNode = memo(FeederNodeImpl)
