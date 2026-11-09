'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { fetchJson } from '@/hooks/fetcher'
import { GlassCard } from '@/components/ui/glass-card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { historyRow } from '@/lib/validate/stats'
import { PreviewLeadsButton, RenamableName } from '@/components/validate/ValidatedPreview'

type Row = ReturnType<typeof historyRow>
interface Page {
  rows: Row[]
  total: number
  page: number
  page_size: number
  days: number
}

const PAGE_SIZE = 25
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`)

/**
 * Validate's "Validation history": completed jobs of the last 30 days, one row
 * each (source, total, valid / invalid / error %, top invalid reason) to
 * compare list quality by source. Collapsed; loads when opened, paged.
 */
export function ValidationHistory() {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const q = useSWR<Page>(open ? `/api/validation/history?page=${page}&page_size=${PAGE_SIZE}&days=30` : null, fetchJson, { keepPreviousData: true })
  const total = q.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <GlassCard className="gap-0 py-0">
      <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer px-[18px] py-3 text-[13px] font-medium text-fg">Validation history</summary>
        {q.error && !q.data ? (
          <p className="px-[18px] pb-4 text-[12px] text-fg-46" role="alert">
            Couldn&apos;t load the history.
          </p>
        ) : !q.data ? (
          <p className="px-[18px] pb-4 text-[12px] text-fg-46">Loading…</p>
        ) : q.data.rows.length === 0 ? (
          <p className="px-[18px] pb-4 text-[12px] text-fg-46">No validation finished in the last 30 days.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table aria-label="Validation history" className="min-w-[760px] text-[12.5px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-[18px]">Job</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Valid</TableHead>
                    <TableHead className="text-right">Invalid</TableHead>
                    <TableHead className="text-right">Error</TableHead>
                    <TableHead className="pr-[18px]">Top invalid reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="pl-[18px]">
                        <span className="flex items-center gap-1 font-medium text-fg">
                          <RenamableName jobId={r.id} name={r.title} />
                          <PreviewLeadsButton jobId={r.id} name={r.title} />
                        </span>
                        {r.filename && <span className="block max-w-56 truncate text-[11px] text-fg-46">{r.filename}</span>}
                      </TableCell>
                      <TableCell className="text-fg-70">{r.source}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{r.total.toLocaleString('en-US')}</TableCell>
                      <TableCell className="text-right font-mono text-green tabular-nums">{pct(r.valid_pct)}</TableCell>
                      <TableCell className="text-right font-mono text-red tabular-nums" title="invalid ÷ (valid + invalid)">
                        {pct(r.invalid_rate)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-amber tabular-nums">{pct(r.error_pct)}</TableCell>
                      <TableCell className="pr-[18px] text-fg-70">{r.top_invalid ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between border-t border-line px-[18px] py-2 text-[11.5px] text-fg-46">
              <span>
                {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total} · last 30 days
              </span>
              <span className="flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="size-4" />
                </Button>
                {page + 1}/{pages}
                <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight className="size-4" />
                </Button>
              </span>
            </div>
          </>
        )}
      </details>
    </GlassCard>
  )
}
