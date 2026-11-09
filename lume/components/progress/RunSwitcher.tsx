'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { TagChip } from '@/components/tags/TagChip'
import type { RunStatus, RunSummary } from '@/lib/progress/runs'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

const STATUS_WORD: Record<RunStatus, string> = { needs_you: 'Needs you', running: 'Running', failed: 'Failed', done: 'Done' }

/** A run's state as a dot: lime ring = your move, lime pulse = running, red = failed, faint = done. */
export function RunDot({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0 items-center justify-center', className)} title={STATUS_WORD[status]}>
      {status === 'running' && <span className="absolute inset-0 rounded-full bg-lime/60 motion-safe:animate-ping" aria-hidden />}
      <span
        aria-hidden
        className={cn(
          'relative rounded-full',
          status === 'needs_you' && 'size-2.5 bg-lime shadow-[0_0_0_3px_color-mix(in_oklab,var(--lime)_28%,transparent)]',
          status === 'running' && 'size-2 bg-lime',
          status === 'failed' && 'size-2 bg-red',
          status === 'done' && 'size-1.5 bg-fg-24'
        )}
      />
      <span className="sr-only">{STATUS_WORD[status]}</span>
    </span>
  )
}

export interface RunSwitcherProps {
  runs: readonly RunSummary[]
  selectedId: string | null
  statusOf: (run: RunSummary) => RunStatus
  onSelect: (id: string) => void
  /** The list has loaded (so an empty one means no runs). */
  loaded?: boolean
}

const monthOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

/**
 * The CSV picker (owner, 2026-11-09): one dropdown, newest CSV first, the last
 * 4 months only (lib/progress/runs.ts). The trigger shows the selected run;
 * the list is grouped by month with a filter box.
 */
export function RunSwitcher({ runs, selectedId, statusOf, onSelect, loaded = true }: RunSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const selected = runs.find((r) => r.id === selectedId) ?? null
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? runs.filter((r) => `${r.title} ${r.filename ?? ''}`.toLowerCase().includes(needle)) : runs
  }, [runs, q])

  if (loaded && runs.length === 0) {
    return <p className="rounded-xl bg-(--glass-fill) px-4 py-3 text-[12.5px] text-fg-46 backdrop-blur-xl">No CSV runs in the last 4 months — import one and it shows up here.</p>
  }

  let lastMonth = ''
  return (
    <nav aria-label="Runs" className="flex min-w-0 items-center gap-3">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setQ('')
        }}
      >
        <PopoverTrigger
          aria-label={selected ? `CSV: ${selected.title}. Change CSV` : 'Choose a CSV'}
          className="flex h-12 max-w-full min-w-0 items-center gap-3 rounded-2xl bg-(--glass-fill) pr-3 pl-4 text-left backdrop-blur-xl outline-none transition-colors hover:bg-(--glass-fill-strong) focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-(--glass-fill-strong) sm:min-w-[380px]"
        >
          {selected ? (
            <>
              <RunDot status={statusOf(selected)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-fg">{selected.title}</span>
                <span className="block font-mono text-[11px] text-fg-46 tabular-nums">
                  {day(selected.created_at)} · {fmt.format(selected.total_rows)} rows · {STATUS_WORD[statusOf(selected)]}
                </span>
              </span>
            </>
          ) : (
            <span className="flex-1 text-[13px] text-fg-46">{loaded ? 'Choose a CSV' : 'Loading CSVs…'}</span>
          )}
          <span className="font-mono text-[11px] text-fg-46 tabular-nums">{runs.length}</span>
          <ChevronDown className="size-4 shrink-0 text-fg-46" aria-hidden />
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-[min(440px,calc(100vw-2rem))] gap-2 rounded-2xl bg-black/75 p-2 ring-0 backdrop-blur-2xl">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-46" aria-hidden />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter CSVs…" aria-label="Filter CSVs" className="h-9 pl-8 text-[12.5px]" />
          </div>
          <ul className="flex max-h-[60vh] flex-col overflow-y-auto overscroll-contain" aria-label="CSVs, newest first">
            {shown.length === 0 && <li className="px-2.5 py-2 text-[12px] text-fg-46">No CSV matches “{q.trim()}”.</li>}
            {shown.map((r) => {
              const month = monthOf(r.created_at)
              const header = month !== lastMonth
              lastMonth = month
              const status = statusOf(r)
              const isSel = r.id === selectedId
              return (
                <li key={r.id}>
                  {header && <p className="px-2.5 pt-2.5 pb-1 text-[10.5px] font-medium tracking-[0.12em] text-fg-46 uppercase">{month}</p>}
                  <button
                    type="button"
                    aria-current={isSel ? 'true' : undefined}
                    onClick={() => {
                      onSelect(r.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none hover:bg-white/8 focus-visible:bg-white/8',
                      isSel && 'bg-white/10'
                    )}
                  >
                    <RunDot status={status} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-[13px]', isSel ? 'font-medium text-fg' : 'text-fg-70')}>{r.title}</span>
                      <span className="block font-mono text-[11px] text-fg-46 tabular-nums">
                        {day(r.created_at)} · {fmt.format(r.total_rows)} rows{r.kind === 'ingest' ? ' · new' : ''}
                      </span>
                    </span>
                    <span className={cn('shrink-0 text-[11px]', status === 'needs_you' ? 'text-lime' : status === 'failed' ? 'text-red' : 'text-fg-46')}>{STATUS_WORD[status]}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </PopoverContent>
      </Popover>
      {selected && (
        <TagChip
          table={selected.kind === 'job' ? 'validation_jobs' : 'telegram_ingests'}
          id={selected.kind === 'job' ? selected.id : selected.id.slice('ingest:'.length)}
          verticalId={selected.vertical_id}
          name={selected.vertical_name}
          revalidate={['/api/validation-jobs/runs?limit=100', '/api/gates']}
        />
      )}
    </nav>
  )
}
