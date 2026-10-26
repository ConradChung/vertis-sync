'use client'

import { useId } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import { ShimmerBar } from '@/components/overview/parts'
import type { LeadBankFilter } from '@/lib/db/leadBankQuery'
import type { LeadBankRow } from '@/lib/db/types'
import { dragLabel, MAX_DRAG_LEADS, refKey, toRuleFilter, type DragLeads, type LeadRef } from '@/lib/rules/client'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

export interface LeadBankProps {
  rows: LeadBankRow[] | undefined
  total: number
  page: number
  pageSize: number
  error?: unknown
  filter: LeadBankFilter
  onFilterChange: (f: LeadBankFilter) => void
  onPage: (p: number) => void
  selected: ReadonlyMap<string, LeadRef>
  onToggle: (ref: LeadRef) => void
  onTogglePage: (refs: LeadRef[], on: boolean) => void
  onClearSelection: () => void
  onRetry?: () => void
}

/** What a drag from the bank carries: the selection, or every lead matching the filter. */
export function bundleOf(selected: ReadonlyMap<string, LeadRef>, filter: LeadBankFilter, total: number): DragLeads {
  return selected.size
    ? { type: 'leads', refs: [...selected.values()].slice(0, MAX_DRAG_LEADS) }
    : { type: 'filter', filter: toRuleFilter(filter), total }
}

/**
 * `lume_lead_bank`: validated leads not yet banked, plus lead_bank rows still
 * queued. Select rows and drag the bundle (or one row's grip) onto a campaign
 * card; with nothing selected the bundle is "all N matching". A drop only
 * asks for confirmation — nothing is assigned until you tap.
 */
export function LeadBank(p: LeadBankProps) {
  const loading = p.rows === undefined && p.error == null
  const rows = p.rows ?? []
  const refs = rows.map((r) => ({ origin: r.origin, id: r.id }))
  const allOnPage = refs.length > 0 && refs.every((r) => p.selected.has(refKey(r)))
  const bundle = bundleOf(p.selected, p.filter, p.total)
  const pages = Math.max(1, Math.ceil(p.total / p.pageSize))

  return (
    <section className="surface min-w-0 overflow-hidden rounded-panel" aria-label="Lead bank">
      <div className="flex flex-wrap items-center justify-between gap-3 px-[18px] py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold text-fg">Lead bank</h2>
          <span className="font-mono text-[11px] text-fg-46">{fmt.format(p.total)}</span>
        </div>
        <div className="flex items-center gap-2">
          {p.selected.size > 0 && (
            <button type="button" onClick={p.onClearSelection} className="text-[12px] text-fg-46 hover:text-fg">
              Clear {fmt.format(p.selected.size)}
            </button>
          )}
          <Bundle drag={bundle} disabled={p.total === 0 && p.selected.size === 0} />
        </div>
      </div>
      <Filters filter={p.filter} onChange={p.onFilterChange} />
      {p.error != null && (
        <p className="flex items-center gap-3 border-t border-line px-[18px] py-2.5 text-[12px] text-amber" role="status">
          {p.rows ? "Couldn't refresh — showing the last data." : "Couldn't load the lead bank."}
          {p.onRetry && (
            <button type="button" onClick={p.onRetry} className="text-violet-soft hover:text-fg">
              Retry
            </button>
          )}
        </p>
      )}
      {loading ? (
        <div className="flex flex-col gap-3 border-t border-line px-[18px] py-4" aria-busy="true" aria-label="Loading lead bank">
          {[0, 1, 2, 3, 4].map((i) => (
            <ShimmerBar key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="border-t border-line px-[18px] py-8 text-center text-[13px] text-fg-46">
          No leads match — validated leads land here once their job completes.
        </p>
      ) : (
        <div className="max-h-[560px] overflow-auto border-t border-line">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-[1] bg-surface text-left text-[11px] text-fg-46">
              <tr>
                <th className="w-8 px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select this page"
                    checked={allOnPage}
                    onChange={(e) => p.onTogglePage(refs, e.target.checked)}
                    className="accent-[var(--violet)]"
                  />
                </th>
                <th className="w-6" aria-label="Drag" />
                <th className="px-2 py-2 font-medium">Lead</th>
                <th className="px-2 py-2 font-medium">Company</th>
                <th className="hidden px-2 py-2 font-medium md:table-cell">City</th>
                <th className="hidden px-2 py-2 font-medium md:table-cell">ICP</th>
                <th className="px-2 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <LeadRow key={`${r.origin}:${r.id}`} row={r} selected={p.selected} onToggle={p.onToggle} filter={p.filter} total={p.total} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.total > p.pageSize && (
        <nav className="flex items-center justify-between border-t border-line px-[18px] py-2 text-[12px] text-fg-46" aria-label="Lead bank pages">
          <button type="button" disabled={p.page <= 1} onClick={() => p.onPage(p.page - 1)} className="hover:text-fg disabled:opacity-40">
            ← Prev
          </button>
          <span className="font-mono">
            {p.page} / {pages}
          </span>
          <button type="button" disabled={p.page >= pages} onClick={() => p.onPage(p.page + 1)} className="hover:text-fg disabled:opacity-40">
            Next →
          </button>
        </nav>
      )}
    </section>
  )
}

function Bundle({ drag, disabled }: { drag: DragLeads; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: 'lead-bundle', data: drag, disabled })
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={`Drag ${dragLabel(drag)} onto a campaign`}
      className={cn(
        'inline-flex h-7 cursor-grab touch-none items-center gap-1.5 rounded-[10px] border border-primary/40 bg-accent px-2.5 text-[12px] text-fg active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40',
        isDragging && 'opacity-50'
      )}
    >
      <GripVertical className="size-3.5" aria-hidden />
      Drag {dragLabel(drag)}
    </button>
  )
}

function LeadRow({
  row,
  selected,
  onToggle,
  filter,
  total,
}: {
  row: LeadBankRow
  selected: ReadonlyMap<string, LeadRef>
  onToggle: (r: LeadRef) => void
  filter: LeadBankFilter
  total: number
}) {
  const ref = { origin: row.origin, id: row.id }
  const isSel = selected.has(refKey(ref))
  // A selected row's grip carries the whole selection; any other row carries itself.
  const drag: DragLeads = isSel ? bundleOf(selected, filter, total) : { type: 'leads', refs: [ref] }
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `lead:${refKey(ref)}`, data: drag })
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ')
  return (
    <tr className={cn('border-t border-line/60', isSel && 'bg-accent', isDragging && 'opacity-50')}>
      <td className="px-2 py-1.5">
        <input
          type="checkbox"
          checked={isSel}
          onChange={() => onToggle(ref)}
          aria-label={`Select ${row.email ?? row.id}`}
          className="accent-[var(--violet)]"
        />
      </td>
      <td className="px-0 py-1.5">
        <button
          ref={setNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${dragLabel(drag)} onto a campaign`}
          className="grid size-5 cursor-grab touch-none place-items-center rounded text-fg-24 hover:text-fg-70 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
      </td>
      <td className="max-w-[220px] px-2 py-1.5">
        <div className="truncate text-fg">{name || '—'}</div>
        <div className="truncate font-mono text-[11px] text-fg-46">{row.email}</div>
      </td>
      <td className="max-w-[160px] truncate px-2 py-1.5 text-fg-70">{row.company_name ?? '—'}</td>
      <td className="hidden max-w-[120px] truncate px-2 py-1.5 text-fg-70 md:table-cell">{row.city ?? '—'}</td>
      <td className="hidden px-2 py-1.5 text-fg-70 md:table-cell">{row.icp_status ?? '—'}</td>
      <td className="px-2 py-1.5">
        <span className={cn('text-[11px]', row.state === 'queued' ? 'text-amber' : 'text-fg-46')}>{row.state}</span>
      </td>
    </tr>
  )
}

function Filters({ filter, onChange }: { filter: LeadBankFilter; onChange: (f: LeadBankFilter) => void }) {
  const id = useId()
  const field = 'h-7 rounded-[8px] border border-line bg-white/[.03] px-2 text-[12px] text-fg placeholder:text-fg-24 focus-visible:outline-2 focus-visible:outline-violet'
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-[18px] py-2.5" role="group" aria-label="Lead bank filters">
      <label className="sr-only" htmlFor={`${id}-src`}>
        Source
      </label>
      <select
        id={`${id}-src`}
        className={field}
        value={filter.origin ?? ''}
        onChange={(e) => onChange({ ...filter, origin: e.target.value || undefined })}
      >
        <option value="">All sources</option>
        <option value="validation_rows">Unassigned (validated)</option>
        <option value="lead_bank">Queued in lead_bank</option>
      </select>
      <label className="sr-only" htmlFor={`${id}-icp`}>
        ICP status
      </label>
      <input
        id={`${id}-icp`}
        className={cn(field, 'w-24')}
        placeholder="ICP"
        value={filter.icp_status ?? ''}
        onChange={(e) => onChange({ ...filter, icp_status: e.target.value || undefined })}
      />
      <label className="sr-only" htmlFor={`${id}-city`}>
        City contains
      </label>
      <input
        id={`${id}-city`}
        className={cn(field, 'w-32')}
        placeholder="City"
        value={filter.city ?? ''}
        onChange={(e) => onChange({ ...filter, city: e.target.value || undefined })}
      />
      <label className="sr-only" htmlFor={`${id}-since`}>
        Since
      </label>
      <input
        id={`${id}-since`}
        type="date"
        className={field}
        value={filter.since ?? ''}
        onChange={(e) => onChange({ ...filter, since: e.target.value || undefined })}
      />
    </div>
  )
}
