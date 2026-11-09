'use client'

import { Check, X } from 'lucide-react'
import { STATE_WORD, type FlowNode, type StepId } from '@/lib/progress/flow'
import { cn } from '@/lib/utils'

const DIM = new Set(['todo', 'skipped'])

/** The node's mark: lime check (done), lime pulse (running), lime ring + dot (your move), red cross, dashed (skipped), faint ring (not started). */
function Mark({ state }: { state: FlowNode['state'] }) {
  return (
    <span className="relative flex size-[30px] shrink-0 items-center justify-center" aria-hidden>
      {state === 'active' && <span className="absolute inset-0 rounded-full bg-lime/25 motion-safe:animate-ping" />}
      <span
        className={cn(
          'relative flex size-[30px] items-center justify-center rounded-full',
          state === 'done' && 'bg-lime text-black',
          state === 'active' && 'bg-black shadow-[inset_0_0_0_2px_var(--lime)]',
          state === 'needs_you' && 'bg-black shadow-[inset_0_0_0_3px_var(--lime),0_0_18px_-2px_color-mix(in_oklab,var(--lime)_70%,transparent)]',
          state === 'failed' && 'bg-red/20 text-red shadow-[inset_0_0_0_2px_var(--red)]',
          state === 'skipped' && 'bg-black/40 shadow-[inset_0_0_0_1.5px_var(--fg-24)] [outline:1.5px_dashed_var(--fg-24)] [outline-offset:-1.5px]',
          state === 'todo' && 'bg-black/50 shadow-[inset_0_0_0_1.5px_var(--fg-24)]'
        )}
      >
        {state === 'done' && <Check className="size-4" strokeWidth={3} />}
        {state === 'failed' && <X className="size-4" strokeWidth={3} />}
        {state === 'active' && <span className="size-2 rounded-full bg-lime motion-safe:animate-pulse" />}
        {state === 'needs_you' && <span className="size-2.5 rounded-full bg-lime" />}
      </span>
    </span>
  )
}

function MiniBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <span className="mt-1 block h-1 w-full max-w-[96px] overflow-hidden rounded-full bg-white/12" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${pct}%`}>
      <i className="block h-full rounded-full bg-lime transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </span>
  )
}

export interface FlowChartProps {
  nodes: readonly FlowNode[]
  selected: StepId
  onSelect: (id: StepId) => void
}

/**
 * One run as a pipeline: nodes joined by a line, lime where the run has
 * been, dashed into skipped steps. Horizontal from `sm`, vertical on phones.
 * A node selects its step (the detail panel below).
 */
export function FlowChart({ nodes, selected, onSelect }: FlowChartProps) {
  return (
    <ol aria-label="Pipeline" className="flex flex-col sm:grid sm:auto-cols-[minmax(92px,1fr)] sm:grid-flow-col sm:overflow-x-auto">
      {nodes.map((n, i) => {
        const prev = nodes[i - 1]
        const next = nodes[i + 1]
        const isSel = n.id === selected
        const dim = DIM.has(n.state)
        // The line into this node: lime once the previous step is done; dashed into a skipped step.
        const inLit = prev?.state === 'done'
        const outLit = n.state === 'done'
        const lineCls = (lit: boolean, dashed: boolean) => (dashed ? 'border-dashed border-fg-24' : lit ? 'border-lime' : 'border-white/15')
        return (
          <li key={n.id} className="relative">
            {/* Connectors: horizontal halves from sm, one vertical segment on phones. */}
            {prev && <span aria-hidden className={cn('absolute top-[21px] right-1/2 left-0 mr-[19px] hidden border-t-[1.5px] sm:block', lineCls(inLit, n.state === 'skipped'))} />}
            {next && <span aria-hidden className={cn('absolute top-[21px] right-0 left-1/2 ml-[19px] hidden border-t-[1.5px] sm:block', lineCls(outLit, next.state === 'skipped'))} />}
            {next && <span aria-hidden className={cn('absolute top-[42px] bottom-[-6px] left-[21px] border-l-[1.5px] sm:hidden', lineCls(outLit, next.state === 'skipped'))} />}
            <button
              type="button"
              onClick={() => onSelect(n.id)}
              aria-current={isSel ? 'step' : undefined}
              aria-label={`${n.label}: ${STATE_WORD[n.state]}`}
              data-step={n.id}
              data-state={n.state}
              className={cn(
                'relative grid w-full grid-cols-[30px_minmax(0,1fr)] items-start gap-x-3 rounded-xl px-1.5 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'sm:flex sm:flex-col sm:items-center sm:gap-0 sm:px-1 sm:pb-2.5 sm:text-center',
                isSel ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
              )}
            >
              <Mark state={n.state} />
              <span className="flex min-w-0 flex-col pb-3 sm:mt-2 sm:w-full sm:items-center sm:pb-0">
                <span className={cn('flex items-baseline gap-2 text-[13px] leading-tight font-medium sm:block', dim ? 'text-fg-46' : 'text-fg')}>
                  {n.label}
                  {n.state === 'needs_you' && <span className="text-[11px] font-semibold text-lime sm:mt-0.5 sm:block">Your move</span>}
                  {n.state === 'failed' && <span className="text-[11px] font-semibold text-red sm:mt-0.5 sm:block">Failed</span>}
                  {n.state === 'skipped' && <span className="text-[11px] text-fg-24 sm:mt-0.5 sm:block">Skipped</span>}
                </span>
                {n.state === 'active' && n.progress && <MiniBar done={n.progress.done} total={n.progress.total} />}
                {n.metrics.length > 0 && (
                  <span className="mt-1 flex min-w-0 flex-wrap gap-x-2 text-[11px] leading-[1.45] text-fg-46 tabular-nums sm:block sm:w-full">
                    {n.metrics.slice(0, 3).map((m) => (
                      <span key={m} className="block truncate" title={m}>
                        {m}
                      </span>
                    ))}
                  </span>
                )}
                {n.state === 'active' && n.eta && <span className="mt-0.5 block truncate text-[10.5px] text-lime/90 sm:w-full">{n.eta.replace(/^(Validating|Enriching) · /, '')}</span>}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
