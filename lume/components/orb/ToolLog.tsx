'use client'

import { Check, Clock, Loader2, X } from 'lucide-react'

export interface ToolLogEntry {
  id: string
  name: string
  tier: 'read' | 'low' | 'high'
  status: 'running' | 'ok' | 'error' | 'awaiting'
  ms?: number
  error?: string
}

/** One mono line per tool call as it runs: name, tier, result, duration. */
export function ToolLog({ entries }: { entries: ToolLogEntry[] }) {
  if (!entries.length) return null
  return (
    <section aria-label="Tool activity" className="rounded-panel border border-line bg-muted p-3">
      <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-fg-46">Activity</h3>
      <ol className="flex flex-col gap-1 font-mono text-[11px] leading-5">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center gap-2 text-fg-70" title={e.error}>
            {e.status === 'running' ? (
              <Loader2 className="size-3 animate-spin text-violet-soft" aria-label="running" />
            ) : e.status === 'ok' ? (
              <Check className="size-3 text-green" aria-label="done" />
            ) : e.status === 'awaiting' ? (
              <Clock className="size-3 text-amber" aria-label="awaiting approval" />
            ) : (
              <X className="size-3 text-red" aria-label="failed" />
            )}
            <span className="truncate">{e.name}</span>
            <span className="text-fg-24">{e.tier}</span>
            {e.status === 'awaiting' && <span className="text-amber">needs approval</span>}
            {e.status === 'error' && <span className="truncate text-red">{e.error}</span>}
            {e.ms !== undefined && <span className="ml-auto text-fg-46">{(e.ms / 1000).toFixed(1)}s</span>}
          </li>
        ))}
      </ol>
    </section>
  )
}
