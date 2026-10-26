'use client'

import { AnimatedNumber } from '@/components/ui/animated-number'
import type { KeyboardEvent } from 'react'
import { ShimmerBar, useNow } from '@/components/overview/parts'
import { StatusBadge } from '@/components/import/StatusBadge'
import type { OrderKind, OrderRow } from '@/lib/db/types'
import { ago, costLabel, sourceLabel, summaryLabel } from '@/lib/import/format'
import { cn } from '@/lib/utils'

export interface OrdersTableProps {
  orders: OrderRow[] | undefined
  error?: unknown
  selected: { kind: OrderKind; id: string } | null
  onSelect: (o: { kind: OrderKind; id: string }) => void
  onRetry?: () => void
}

const COLS = ['Source', 'Summary', 'Rows', 'Status', 'Cost', 'Created by', 'When'] as const
// Cost and Created by step aside on phones; the rail shows them.
const NARROW_HIDDEN: ReadonlySet<string> = new Set(['Cost', 'Created by'])

/** Every intake, newest first. A row opens the order panel. */
export function OrdersTable({ orders, error, selected, onSelect, onRetry }: OrdersTableProps) {
  const now = useNow(60_000)
  const loading = orders === undefined && error == null

  return (
    <section className="surface min-w-0 overflow-hidden rounded-panel" aria-label="Orders">
      <div className="flex items-center justify-between gap-3 px-[18px] py-3">
        <h2 className="text-[13px] font-semibold text-fg">Orders</h2>
        {orders && <AnimatedNumber value={orders.length} className="font-mono text-[11px] text-fg-46" />}
      </div>
      {error != null && (
        <p className="flex items-center gap-3 border-t border-line px-[18px] py-2.5 text-[12px] text-amber" role="status">
          {orders ? "Couldn't refresh — showing the last data." : "Couldn't load orders."}
          {onRetry && (
            <button type="button" onClick={onRetry} className="text-violet-soft hover:text-fg">
              Retry
            </button>
          )}
        </p>
      )}
      {loading ? (
        <div className="flex flex-col gap-3 border-t border-line px-[18px] py-4" aria-busy="true" aria-label="Loading orders">
          {[0, 1, 2, 3, 4].map((i) => (
            <ShimmerBar key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : orders && orders.length === 0 ? (
        <p className="border-t border-line px-[18px] py-8 text-center text-[13px] text-fg-46">
          No orders yet — pull a source above.
        </p>
      ) : orders ? (
        <div className="max-h-[640px] overflow-auto border-t border-line">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-[1] bg-surface text-left text-[11px] text-fg-46">
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className={cn(
                      'border-b border-line px-3 py-2.5 font-medium first:pl-[18px] last:pr-[18px]',
                      c === 'Rows' && 'text-right',
                      NARROW_HIDDEN.has(c) && 'hidden md:table-cell'
                    )}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const isSel = selected?.id === o.id && selected.kind === o.kind
                const open = () => onSelect({ kind: o.kind, id: o.id })
                const onKey = (e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    open()
                  }
                }
                return (
                  <tr
                    key={`${o.kind}:${o.id}`}
                    tabIndex={0}
                    aria-current={isSel || undefined}
                    data-order={`${o.kind}:${o.id}`}
                    onClick={open}
                    onKeyDown={onKey}
                    className={cn(
                      'cursor-pointer border-b border-line/60 text-fg-70 outline-none transition-colors last:border-0',
                      'hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                      isSel && 'bg-accent text-fg'
                    )}
                  >
                    <td className="px-3 py-2.5 pl-[18px] whitespace-nowrap">{sourceLabel(o.source)}</td>
                    <td className="max-w-[130px] truncate px-3 py-2.5 text-fg sm:max-w-[260px]" title={o.summary ?? undefined}>
                      {summaryLabel(o)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{o.row_count == null ? '—' : <AnimatedNumber value={o.row_count} />}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="hidden px-3 py-2.5 font-mono tabular-nums md:table-cell">{costLabel(o)}</td>
                    <td className="hidden px-3 py-2.5 whitespace-nowrap text-fg-46 md:table-cell">{o.created_by ?? '—'}</td>
                    <td className="px-3 py-2.5 pr-[18px] whitespace-nowrap text-fg-46">
                      <time dateTime={o.created_at} suppressHydrationWarning>
                        {ago(o.created_at, now)}
                      </time>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
