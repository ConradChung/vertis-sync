'use client'

import type { GateRow } from '@/lib/db/types'
import { groupByKind, type ButtonSpec } from '@/lib/validate/actions'
import { gateKey } from '@/lib/validate/deepLink'
import { GateCard } from '@/components/validate/GateCard'

export interface GateListProps {
  gates: GateRow[]
  focusedKey: string | null
  busyKeys: ReadonlySet<string>
  countOpenKey?: string | null
  onAction: (gate: GateRow, spec: ButtonSpec, count?: number) => void
  onCountOpenChange?: (key: string, open: boolean) => void
  onFocusGate: (key: string) => void
  blockedFor?: (gate: GateRow) => Readonly<Record<string, string>> | undefined
}

/** Open gates grouped by kind, each group headed by its label and count. */
export function GateList({ gates, focusedKey, busyKeys, countOpenKey, onAction, onCountOpenChange, onFocusGate, blockedFor }: GateListProps) {
  return (
    <div className="flex flex-col gap-5">
      {groupByKind(gates).map((group) => (
        <section key={group.kind} aria-labelledby={`grp-${group.kind}`} data-group={group.kind}>
          <h2 id={`grp-${group.kind}`} className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[1.5px] text-fg-46 uppercase">
            {group.label}
            <span className="rounded-[5px] bg-accent px-1.5 py-px font-mono text-[10px] tracking-normal text-violet-soft tabular-nums">
              {group.gates.length}
            </span>
          </h2>
          <div className="flex flex-col gap-3">
            {group.gates.map((g) => {
              const key = gateKey(g)
              return (
                <GateCard
                  key={key}
                  gate={g}
                  focused={key === focusedKey}
                  busy={busyKeys.has(key)}
                  countOpen={countOpenKey === key}
                  onAction={(spec, count) => onAction(g, spec, count)}
                  onCountOpenChange={(open) => onCountOpenChange?.(key, open)}
                  onFocusCard={() => onFocusGate(key)}
                  blocked={blockedFor?.(g)}
                />
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
