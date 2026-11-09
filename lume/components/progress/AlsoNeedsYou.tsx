'use client'

import { ChevronRight } from 'lucide-react'
import { GateCard } from '@/components/validate/GateCard'
import { RunDot } from '@/components/progress/RunSwitcher'
import type { GateRow } from '@/lib/db/types'
import { STEP_LABEL } from '@/lib/progress/flow'
import { stepOfGate, type RunSummary } from '@/lib/progress/runs'
import type { ButtonSpec } from '@/lib/validate/actions'
import { gateKey } from '@/lib/validate/deepLink'

export interface AlsoNeedsYouProps {
  /** Gates outside any CSV run (job batches, Leadsfriday counts, other confirmations): decided right here. */
  gates: readonly GateRow[]
  /** Other runs waiting on the owner: one row each, opening that run (their buttons live in its step panel). */
  otherRuns: readonly { run: RunSummary; gate: GateRow }[]
  focusedKey: string | null
  busyKeys: ReadonlySet<string>
  countOpenKey: string | null
  onAction: (gate: GateRow, spec: ButtonSpec, count?: number) => void
  onCountOpenChange: (key: string, open: boolean) => void
  onFocusGate: (key: string) => void
  onOpenRun: (runId: string) => void
  /** The gates haven't loaded yet. */
  loading?: boolean
}

/** Everything else waiting on the owner — secondary to the selected run. */
export function AlsoNeedsYou({ gates, otherRuns, focusedKey, busyKeys, countOpenKey, onAction, onCountOpenChange, onFocusGate, onOpenRun, loading }: AlsoNeedsYouProps) {
  const total = gates.length + otherRuns.length
  return (
    <section aria-label="Also needs you" className="flex flex-col">
      <h2 className="flex items-center gap-2 px-3 pt-1 pb-2 text-[12.5px] font-medium text-fg-70">
        Also needs you
        {!loading && <span className={total ? 'font-mono text-[11px] text-lime tabular-nums' : 'font-mono text-[11px] text-fg-46 tabular-nums'}>{total}</span>}
      </h2>
      {loading && <p className="px-3 pb-2 text-[12px] text-fg-46">Loading…</p>}
      {!loading && total === 0 && <p className="px-3 pb-2 text-[12px] text-fg-46">Nothing else is waiting on you.</p>}
      {otherRuns.map(({ run, gate }) => {
        const step = stepOfGate(gate)
        return (
          <button
            key={run.id}
            type="button"
            onClick={() => onOpenRun(run.id)}
            className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RunDot status="needs_you" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-fg">{run.title}</span>
              <span className="block text-[11px] text-fg-46">{step ? `${STEP_LABEL[step]} · your move` : 'Your move'}</span>
            </span>
            <span className="flex items-center gap-0.5 text-[11.5px] text-fg-46 group-hover:text-fg">
              Open run <ChevronRight className="size-3.5" aria-hidden />
            </span>
          </button>
        )
      })}
      {gates.map((g) => {
        const key = gateKey(g)
        return (
          <GateCard
            key={key}
            gate={g}
            focused={key === focusedKey}
            busy={busyKeys.has(key)}
            countOpen={countOpenKey === key}
            onAction={(spec, count) => onAction(g, spec, count)}
            onCountOpenChange={(open) => onCountOpenChange(key, open)}
            onFocusCard={() => onFocusGate(key)}
          />
        )
      })}
    </section>
  )
}
