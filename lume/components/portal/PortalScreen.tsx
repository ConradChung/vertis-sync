'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft, ChevronRight, RotateCw, Search, SearchX, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useNow, usePortalLeads } from '@/hooks/usePortal'
import { cn } from '@/lib/utils'
import type { PortalSort, PortalTab } from '@/lib/portal/types'
import { filtersFromParams, portalHref, switchTab, type PortalFilters } from './query'
import { LeadCard } from './LeadCard'
import { LeadsTable } from './LeadsTable'
import { AgentPanel } from './AgentPanel'

const TABS: { tab: PortalTab; label: string }[] = [
  { tab: 'email', label: 'Email campaigns' },
  { tab: 'linkedin', label: 'LinkedIn' },
]

const SORT_LABEL: Record<PortalSort, string> = { company: 'Company', name: 'Name', region: 'Region' }

/** Desktop gets the assistant as a side panel; below this it is a bottom sheet. */
const WIDE_QUERY = '(min-width: 1024px)'

const nf = new Intl.NumberFormat('en-US')

/**
 * The client portal: the client's leads, read-only, built for cold-calling
 * from a phone. Filters live in the URL so links are shareable and the back
 * button works; `as` (owner preview) rides along on every URL and API call.
 */
export function PortalScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname() || '/portal'
  const as = params.get('as')
  const filters = useMemo(() => filtersFromParams(params), [params])
  const now = useNow()

  const go = useCallback(
    (next: PortalFilters, mode: 'push' | 'replace' = 'push') => {
      const href = portalHref(next, as).replace(/^\/portal/, pathname)
      if (mode === 'replace') router.replace(href, { scroll: false })
      else router.push(href, { scroll: false })
    },
    [as, pathname, router]
  )

  // Search: local input, debounced into the URL (replace, so typing doesn't stack history).
  const [q, setQ] = useState(filters.q)
  const lastSent = useRef(filters.q)
  useEffect(() => {
    // URL changed from elsewhere (back button, shared link): reflect it in the box.
    if (filters.q !== lastSent.current) {
      lastSent.current = filters.q
      setQ(filters.q)
    }
  }, [filters.q])
  useEffect(() => {
    if (q.trim() === filters.q.trim()) return
    const t = setTimeout(() => {
      lastSent.current = q.trim()
      go({ ...filters, q, page: 1 }, 'replace')
    }, 250)
    return () => clearTimeout(t)
  }, [q, filters, go])

  const active = usePortalLeads(filters, as)
  // The other tab's count, as it would read if switched to now.
  const otherTab: PortalTab = filters.tab === 'email' ? 'linkedin' : 'email'
  const other = usePortalLeads(switchTab({ ...filters, page: 1 }, otherTab), as)
  const totals: Record<PortalTab, number | undefined> = {
    [filters.tab]: active.data?.total,
    [otherTab]: other.data?.total,
  } as Record<PortalTab, number | undefined>

  const data = active.data
  const pageCount = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || 50))) : 1
  const regions = useMemo(() => {
    const r = data?.regions ?? []
    return filters.region && !r.includes(filters.region) ? [filters.region, ...r] : r
  }, [data?.regions, filters.region])

  const setPage = (page: number) => {
    go({ ...filters, page })
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const wide = useMediaQuery(WIDE_QUERY)
  const [agentOpen, setAgentOpen] = useState(false)

  const filtered = Boolean(filters.q || filters.region || filters.repliedPositive || filters.hasPhone)

  return (
    <div className={cn('mx-auto grid w-full max-w-[1600px] gap-6', agentOpen && wide && 'lg:grid-cols-[minmax(0,1fr)_400px]')}>
      <section className="flex min-w-0 flex-col gap-4">
        {/* Tabs */}
        <div className="flex items-center justify-between gap-3">
          <div role="tablist" aria-label="Lead source" className="glass flex min-w-0 gap-1 rounded-2xl p-1">
            {TABS.map(({ tab, label }) => {
              const selected = filters.tab === tab
              const n = totals[tab]
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => !selected && go(switchTab(filters, tab))}
                  className={cn(
                    'flex h-11 min-w-0 items-center gap-2 rounded-xl px-3.5 text-[14px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:h-9',
                    selected ? 'bg-secondary text-fg shadow-[inset_0_1px_0_0_var(--glass-highlight)]' : 'text-fg-46 hover:text-fg'
                  )}
                >
                  {label}
                  <span className={cn('rounded-full px-1.5 text-[12px] tabular-nums', selected ? 'bg-primary/15 text-positive' : 'text-fg-24')}>
                    {n == null ? '·' : nf.format(n)}
                  </span>
                </button>
              )
            })}
          </div>
          <Button
            variant="ghost"
            onClick={() => setAgentOpen((o) => !o)}
            aria-expanded={agentOpen}
            className="glass hidden h-11 shrink-0 gap-2 rounded-2xl px-4 text-[14px] md:inline-flex md:h-11"
          >
            <Sparkles className="text-positive" /> Ask the assistant
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-2.5 md:flex-row md:flex-wrap md:items-center">
          <div className="relative min-w-0 md:max-w-sm md:flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-fg-46" aria-hidden />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, company, phone, city"
              aria-label="Search leads"
              enterKeyHint="search"
              className="glass h-12 w-full rounded-2xl pr-11 pl-10 text-[15px] text-fg outline-none placeholder:text-fg-24 focus-visible:ring-2 focus-visible:ring-ring md:h-10 md:text-[14px] [&::-webkit-search-cancel-button]:hidden"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                aria-label="Clear search"
                className="absolute top-1/2 right-1 grid size-10 -translate-y-1/2 place-items-center rounded-xl text-fg-46 hover:text-fg md:size-8"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <select
              aria-label="Region"
              value={filters.region}
              onChange={(e) => go({ ...filters, region: e.target.value, page: 1 })}
              className="glass h-11 max-w-[11rem] min-w-0 flex-1 rounded-xl px-3 text-[14px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:flex-none md:text-[13px]"
            >
              <option value="">All regions</option>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort by"
              value={filters.sort}
              onChange={(e) => go({ ...filters, sort: e.target.value as PortalSort, page: 1 })}
              className="glass h-11 max-w-[10rem] min-w-0 flex-1 rounded-xl px-3 text-[14px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:flex-none md:text-[13px]"
            >
              {(Object.keys(SORT_LABEL) as PortalSort[]).map((s) => (
                <option key={s} value={s}>
                  Sort: {SORT_LABEL[s]}
                </option>
              ))}
            </select>
            <Toggle pressed={filters.hasPhone} onChange={(v) => go({ ...filters, hasPhone: v, page: 1 })}>
              Has phone
            </Toggle>
            <Toggle pressed={filters.repliedPositive} onChange={(v) => go({ ...filters, repliedPositive: v, page: 1 })}>
              Replied (positive)
            </Toggle>
          </div>
        </div>

        {/* Results */}
        {active.error && !data ? (
          <ErrorState onRetry={() => void active.mutate()} message={active.error instanceof Error ? active.error.message : undefined} />
        ) : !data ? (
          <ResultsSkeleton />
        ) : data.rows.length === 0 ? (
          <Empty className="glass rounded-2xl py-14">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchX />
              </EmptyMedia>
              <EmptyTitle>No leads match</EmptyTitle>
              <EmptyDescription>{filtered ? 'Try a shorter search or turn a filter off.' : 'Nothing on this tab yet.'}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className={cn('flex flex-col gap-4 transition-opacity', active.isValidating && 'opacity-70')}>
            {active.error && (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert">
                Could not refresh. Showing the last results.
                <Button variant="ghost" size="sm" className="h-9 text-destructive" onClick={() => void active.mutate()}>
                  <RotateCw /> Retry
                </Button>
              </div>
            )}
            <div className="glass hidden overflow-hidden rounded-2xl md:block">
              <LeadsTable rows={data.rows} now={now} />
            </div>
            <div className="flex flex-col gap-3 md:hidden">
              {data.rows.map((l) => (
                <LeadCard key={`${l.kind}:${l.id}`} lead={l} now={now} />
              ))}
            </div>
            <Pagination page={data.page} pageCount={pageCount} total={data.total} pageSize={data.pageSize || 50} onPage={setPage} />
          </div>
        )}
      </section>

      {/* Assistant: side panel on desktop, bottom sheet on phones/tablets. */}
      {wide && agentOpen && (
        <aside className="glass sticky top-[calc(var(--portal-header-h)+1rem)] flex h-[calc(100dvh-var(--portal-header-h)-2rem)] min-h-0 flex-col overflow-hidden rounded-2xl" aria-label="Assistant">
          <div className="flex items-center justify-between border-b border-(--line) py-2 pr-2 pl-4">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-fg">
              <Sparkles className="size-4 text-positive" /> Assistant
            </h2>
            <Button variant="ghost" size="icon" aria-label="Close assistant" onClick={() => setAgentOpen(false)} className="size-9">
              <X />
            </Button>
          </div>
          <AgentPanel as={as} className="flex-1" />
        </aside>
      )}
      {!wide && (
        <Sheet open={agentOpen} onOpenChange={setAgentOpen}>
          <SheetContent side="bottom" className="h-[88dvh] gap-0 rounded-t-3xl p-0">
            <SheetHeader className="border-b border-(--line) pb-3">
              <SheetTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-positive" /> Assistant
              </SheetTitle>
            </SheetHeader>
            <AgentPanel as={as} className="min-h-0 flex-1" />
          </SheetContent>
        </Sheet>
      )}
      {/* Phones: a floating button to open the assistant. */}
      {!agentOpen && (
        <button
          type="button"
          onClick={() => setAgentOpen(true)}
          className="glass-overlay fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+16px)] z-40 flex h-12 items-center gap-2 rounded-full px-5 text-[15px] font-medium text-fg md:hidden"
        >
          <Sparkles className="size-4 text-positive" /> Ask the assistant
        </button>
      )}
    </div>
  )
}

function Toggle({ pressed, onChange, children }: { pressed: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={cn(
        'h-11 shrink-0 rounded-xl px-3.5 text-[14px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:text-[13px]',
        pressed ? 'bg-primary text-primary-foreground ring-1 ring-(--lime-edge) ring-inset' : 'glass text-fg-70 hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}

function Pagination({ page, pageCount, total, pageSize, onPage }: { page: number; pageCount: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3 pb-20 text-[13px] text-fg-46 md:pb-0">
      <span className="tabular-nums">
        {nf.format(from)}–{nf.format(to)} of {nf.format(total)} leads
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)} className="glass size-11 rounded-xl md:size-9">
            <ChevronLeft />
          </Button>
          <span className="px-1 tabular-nums">
            {page} / {pageCount}
          </span>
          <Button variant="ghost" aria-label="Next page" disabled={page >= pageCount} onClick={() => onPage(page + 1)} className="glass size-11 rounded-xl md:size-9">
            <ChevronRight />
          </Button>
        </div>
      )}
    </nav>
  )
}

function ResultsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading leads">
      <div className="glass hidden flex-col gap-3 rounded-2xl p-4 md:flex">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full rounded-lg" />
        ))}
      </div>
      <div className="flex flex-col gap-3 md:hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="glass flex flex-col gap-3 rounded-2xl p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ErrorState({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <Empty className="glass rounded-2xl py-14" role="alert">
      <EmptyHeader>
        <EmptyTitle>Couldn&apos;t load leads</EmptyTitle>
        <EmptyDescription>{message && !/^HTTP \d+$/.test(message) ? message : 'Check your connection and try again.'}</EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" onClick={onRetry} className="h-11 px-5">
        <RotateCw /> Retry
      </Button>
    </Empty>
  )
}
