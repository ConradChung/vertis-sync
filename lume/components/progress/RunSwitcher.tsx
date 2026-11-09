'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { TagChip } from '@/components/tags/TagChip'
import { useRunSearch } from '@/hooks/useRuns'
import { fromRunRow, type RunStatus, type RunSummary } from '@/lib/progress/runs'
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

/**
 * The runs, newest activity first, as one scrollable row of tiles: name,
 * date, rows, tag and a status dot. Older runs: "More runs" (search).
 */
export function RunSwitcher({ runs, selectedId, statusOf, onSelect, loaded = true }: RunSwitcherProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  // Keep the selected tile in view (deep links can select one far right).
  useEffect(() => {
    if (!selectedId) return
    const el = rowRef.current?.querySelector<HTMLElement>(`[data-run="${selectedId}"]`)
    if (el && rowRef.current) {
      const box = rowRef.current
      const left = el.offsetLeft - box.offsetLeft
      if (left < box.scrollLeft || left + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' })
    }
  }, [selectedId, runs.length])

  return (
    <nav aria-label="Runs" className="flex min-w-0 items-stretch gap-2">
      <div ref={rowRef} className="flex min-w-0 flex-1 snap-x gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {loaded && runs.length === 0 && (
          <p className="rounded-xl bg-(--glass-fill) px-4 py-3 text-[12.5px] text-fg-46 backdrop-blur-xl">No CSV runs yet — import one and it shows up here.</p>
        )}
        {runs.map((r) => {
          const selected = r.id === selectedId
          const status = statusOf(r)
          return (
            <div key={r.id} data-run={r.id} className="relative shrink-0 snap-start">
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`${r.title} — ${STATUS_WORD[status]}`}
                onClick={() => onSelect(r.id)}
                className={cn(
                  'flex h-full w-[212px] flex-col gap-1.5 rounded-xl px-3.5 pt-3 pb-8 text-left backdrop-blur-xl transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'bg-(--glass-fill-strong)' : 'bg-(--glass-fill) hover:bg-(--glass-fill-strong)'
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <RunDot status={status} />
                  <span className={cn('truncate text-[13px] font-medium', selected ? 'text-fg' : 'text-fg-70')}>{r.title}</span>
                </span>
                <span className="font-mono text-[11px] text-fg-46 tabular-nums">
                  {day(r.created_at)} · {fmt.format(r.total_rows)} rows{r.kind === 'ingest' ? ' · new' : ''}
                </span>
                {selected && <span className="absolute bottom-0 left-3.5 h-0.5 w-8 rounded-full bg-fg" aria-hidden />}
              </button>
              {/* The tag sits over the tile (a button can't hold the tag picker). */}
              <TagChip
                table={r.kind === 'job' ? 'validation_jobs' : 'telegram_ingests'}
                id={r.kind === 'job' ? r.id : r.id.slice('ingest:'.length)}
                verticalId={r.vertical_id}
                name={r.vertical_name}
                revalidate={['/api/validation-jobs/runs?limit=20', '/api/gates']}
                className="absolute bottom-3 left-[34px] max-w-[150px]"
              />
            </div>
          )
        })}
      </div>
      <MoreRuns onSelect={onSelect} />
    </nav>
  )
}

function MoreRuns({ onSelect }: { onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const { data, error } = useRunSearch(open ? debounced : null)
  const results = (data?.runs ?? []).map(fromRunRow)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex w-[92px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl bg-(--glass-fill) px-2 text-[11.5px] text-fg-70 backdrop-blur-xl outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="More runs"
      >
        <Search className="size-4" aria-hidden />
        More runs
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 gap-2 rounded-xl bg-black/75 p-2 ring-0 backdrop-blur-2xl">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a run by name or file…" aria-label="Find a run" className="h-8 text-[12.5px]" />
        <ul className="flex max-h-80 flex-col overflow-y-auto" aria-label="Runs found">
          {error && !data && <li className="px-2 py-2 text-[12px] text-fg-46">Couldn&apos;t load runs.</li>}
          {!data && !error && <li className="px-2 py-2 text-[12px] text-fg-46">Loading…</li>}
          {data && results.length === 0 && <li className="px-2 py-2 text-[12px] text-fg-46">No run matches “{debounced}”.</li>}
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="flex w-full flex-col rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/8 focus-visible:bg-white/8"
                onClick={() => {
                  onSelect(r.id)
                  setOpen(false)
                }}
              >
                <span className="truncate text-[12.5px] text-fg">{r.title}</span>
                <span className="font-mono text-[11px] text-fg-46 tabular-nums">
                  {day(r.created_at)} · {fmt.format(r.total_rows)} rows · {r.status ?? '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
