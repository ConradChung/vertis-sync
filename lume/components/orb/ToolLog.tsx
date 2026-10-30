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

const errorHead = (error?: string) => (error ?? '').split('\n')[0]
/** The "- …" detail lines of a multi-line tool error (each SOP violation is one). */
const errorLines = (error?: string) =>
  (error ?? '')
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))

/** One mono line per tool call as it runs: name, tier, result, duration. */
export function ToolLog({ entries }: { entries: ToolLogEntry[] }) {
  if (!entries.length) return null
  return (
    <section aria-label="Tool activity" className="rounded-panel border border-line bg-muted p-3">
      <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-fg-46">Activity</h3>
      <ol className="flex flex-col gap-1 font-mono text-[11px] leading-5">
        {entries.map((e) => (
          <li key={e.id} className="text-fg-70" title={e.error}>
            <div className="flex items-center gap-2">
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
            {e.status === 'error' && <span className="truncate text-red">{errorHead(e.error)}</span>}
            {e.ms !== undefined && <span className="ml-auto text-fg-46">{(e.ms / 1000).toFixed(1)}s</span>}
            </div>
            {e.status === 'error' && errorLines(e.error).length > 0 && (
              // e.g. SOP lint violations: one line per rule / step / variant.
              <ul className="ml-5 mt-0.5 list-disc whitespace-normal break-words text-red/90">
                {errorLines(e.error).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
