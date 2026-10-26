'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, Globe, Contact as Linkedin, Mail, Phone, Search, Star, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ReviewRow, ReviewSummary } from '@/lib/review/model'
import { cn } from '@/lib/utils'

interface AppliedFilter {
  id: string
  label: string
  changed: number
  undone?: boolean
  action: string
}
interface SetBody {
  set: { id: string; title: string; filters: AppliedFilter[] }
  summary: ReviewSummary
}
type Status = 'kept' | 'excluded' | 'all'

const PAGE = 50

/**
 * The Agent's Leads tab: the conversation's active review set as a table.
 * Kept/excluded counts, chips for applied filters (undo), search, hand
 * exclude/restore via row checkboxes, and "Export kept for Apollo".
 * `refreshKey` changes whenever the agent filters, so its edits show live.
 */
export function LeadsPanel({ setId, refreshKey }: { setId: string; refreshKey: number }) {
  const [meta, setMeta] = useState<SetBody | null>(null)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<Status>('kept')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    setPage(0)
    setPicked(new Set())
  }, [status, query, setId])

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ status, page: String(page), page_size: String(PAGE) })
      if (query) params.set('q', query)
      const [a, b] = await Promise.all([
        fetch(`/api/review-sets/${setId}`, { credentials: 'same-origin' }),
        fetch(`/api/review-sets/${setId}/items?${params}`, { credentials: 'same-origin' }),
      ])
      if (!a.ok || !b.ok) throw new Error(`Could not load leads (${a.ok ? b.status : a.status})`)
      const m = (await a.json()) as SetBody
      const it = (await b.json()) as { rows: ReviewRow[]; total: number }
      setMeta(m)
      setRows(it.rows)
      setTotal(it.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load leads')
    }
  }, [setId, status, page, query])
  useEffect(() => {
    void load()
  }, [load, refreshKey, tick])

  const post = async (path: string, body: unknown) => {
    setWorking(true)
    try {
      const res = await fetch(`/api/review-sets/${setId}/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Update failed (${res.status})`)
      setPicked(new Set())
      setTick((t) => t + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setWorking(false)
    }
  }

  const filters = useMemo(() => (meta?.set.filters ?? []).filter((f) => !f.undone && f.changed > 0), [meta])
  const s = meta?.summary
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const allOnPage = rows.length > 0 && rows.every((r) => picked.has(r.idx))
  const toggle = (idx: number) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(idx)) n.delete(idx)
      else n.add(idx)
      return n
    })

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Lead review">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-fg">{meta?.set.title ?? 'Leads'}</p>
          <p className="font-mono text-[11px] text-fg-46">
            <span className="text-positive">{s?.kept ?? '–'} kept</span> · {s?.excluded ?? '–'} excluded · {s?.total ?? '–'} total
          </p>
        </div>
        {s && (
          <div className="flex items-center gap-3 text-[11.5px] text-fg-46" aria-label="Coverage of kept rows">
            <span className="flex items-center gap-1"><Globe className="size-3" />{s.coverage.website}</span>
            <span className="flex items-center gap-1"><Phone className="size-3" />{s.coverage.phone}</span>
            <span className="flex items-center gap-1"><Mail className="size-3" />{s.coverage.email}</span>
            <span className="flex items-center gap-1"><Linkedin className="size-3" />{s.coverage.linkedin}</span>
          </div>
        )}
        <div className="flex-1" />
        {s?.kept ? (
          <Button size="sm" nativeButton={false} render={<a href={`/api/review-sets/${setId}/export`} download />} aria-label="Export kept for Apollo">
            <Download className="size-3.5" /> Export kept for Apollo
          </Button>
        ) : (
          <Button size="sm" disabled aria-label="Export kept for Apollo">
            <Download className="size-3.5" /> Export kept for Apollo
          </Button>
        )}
      </div>

      {filters.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2" aria-label="Applied filters">
          {filters.map((f) => (
            <span key={f.id} className="anim-rise inline-flex items-center gap-1.5 rounded-full border border-line bg-muted/60 py-0.5 pr-1 pl-2.5 text-[11.5px] text-fg-70">
              {f.label}
              <span className="font-mono text-fg-46">−{f.changed}</span>
              <button
                type="button"
                className="grid size-5 place-items-center rounded-full hover:bg-white/10 light:hover:bg-black/5"
                aria-label={`Undo: ${f.label}`}
                title="Undo"
                disabled={working}
                onClick={() => void post('restore', { filter_id: f.id })}
              >
                <Undo2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <div className="flex rounded-full border border-line p-0.5 text-[12px]" role="tablist" aria-label="Rows">
          {(['kept', 'excluded', 'all'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={status === v}
              onClick={() => setStatus(v)}
              className={cn('rounded-full px-2.5 py-0.5 capitalize text-fg-46 transition-colors', status === v && 'bg-primary text-primary-foreground')}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-46" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, category, city, domain" aria-label="Search leads" className="h-8 pl-8 text-[12.5px]" />
        </div>
        {picked.size > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={working}
            onClick={() => void post('rows', { idxs: [...picked], status: status === 'excluded' ? 'kept' : 'excluded' })}
          >
            {status === 'excluded' ? <Undo2 className="size-3.5" /> : <X className="size-3.5" />}
            {status === 'excluded' ? 'Restore' : 'Exclude'} {picked.size}
          </Button>
        )}
      </div>

      {error && <p className="px-4 pb-2 text-[12px] text-destructive" role="alert">{error}</p>}

      <div className="thin-scroll min-h-0 flex-1 overflow-auto px-2">
        <Table className="text-[12.5px]">
          <TableHeader className="sticky top-0 z-[1] bg-[var(--glass-fill-strong)] backdrop-blur-md">
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={allOnPage}
                  onCheckedChange={(v) => setPicked(v ? new Set(rows.map((r) => r.idx)) : new Set())}
                  aria-label="Select all on this page"
                />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Rating</TableHead>
              <TableHead>Has</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.idx} data-state={picked.has(r.idx) ? 'selected' : undefined} className={cn(r.status === 'excluded' && 'opacity-55')}>
                <TableCell>
                  <Checkbox checked={picked.has(r.idx)} onCheckedChange={() => toggle(r.idx)} aria-label={`Select ${r.item.name ?? `row ${r.idx}`}`} />
                </TableCell>
                <TableCell className="max-w-56">
                  <p className={cn('truncate font-medium text-fg', r.status === 'excluded' && 'line-through')}>{r.item.name ?? '—'}</p>
                  <p className="truncate font-mono text-[10.5px] text-fg-46">
                    {r.status === 'excluded' ? r.excluded_reason : r.item.domain ?? 'no website'}
                  </p>
                </TableCell>
                <TableCell className="max-w-40 truncate text-fg-70">{r.item.category ?? '—'}</TableCell>
                <TableCell className="max-w-36 truncate text-fg-70">{[r.item.city, r.item.state].filter(Boolean).join(', ') || '—'}</TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums text-fg-70">
                  {r.item.rating !== null ? (
                    <span className="inline-flex items-center gap-1">
                      <Star className="size-3 text-positive" />
                      {r.item.rating.toFixed(1)}
                      <span className="text-fg-46">({r.item.reviews_count ?? 0})</span>
                    </span>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5 text-fg-24">
                    <Globe className={cn('size-3.5', (r.item.website || r.item.domain) && 'text-positive')} aria-label={r.item.domain ? 'website' : 'no website'} />
                    <Phone className={cn('size-3.5', r.item.phone && 'text-positive')} aria-label={r.item.phone ? 'phone' : 'no phone'} />
                    <Mail className={cn('size-3.5', r.item.email && 'text-positive')} aria-label={r.item.email ? 'email' : 'no email'} />
                    <Linkedin className={cn('size-3.5', r.item.linkedin_url && 'text-positive')} aria-label={r.item.linkedin_url ? 'LinkedIn' : 'no LinkedIn'} />
                  </span>
                </TableCell>
              </TableRow>
            ))}
            {meta && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-fg-46">
                  {query ? 'No rows match that search.' : status === 'excluded' ? 'Nothing excluded yet.' : 'No rows.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[11.5px] text-fg-46">
        <span>
          {total ? `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${total}` : '0 rows'}
        </span>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon-xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft className="size-3.5" />
          </Button>
          {page + 1}/{pages}
          <Button variant="ghost" size="icon-xs" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
            <ChevronRight className="size-3.5" />
          </Button>
        </span>
      </div>
    </div>
  )
}
