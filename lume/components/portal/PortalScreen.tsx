'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Building2, ChevronDown, LoaderCircle, Maximize2, Minimize2, RotateCw, Search, SearchX, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useNow, usePortalLeads, usePortalLeadsInfinite } from '@/hooks/usePortal'
import { cn } from '@/lib/utils'
import type { PortalSort, PortalTab } from '@/lib/portal/types'
import { defaultFilters, filtersFromParams, portalHref, switchTab, type PortalFilters } from './query'
import { LeadCard } from './LeadCard'
import { LeadsTable } from './LeadsTable'
import { AgentPanel } from './AgentPanel'
import { SignalsSection } from './SignalsSection'

const TABS: { tab: PortalTab; label: string }[] = [
  { tab: 'email', label: 'Email campaigns' },
  { tab: 'linkedin', label: 'LinkedIn' },
  { tab: 'sheet', label: 'Call sheets' },
]

const SORT_LABEL: Record<PortalSort, string> = {
  company: 'Company',
  name: 'Name',
  region: 'Region',
}

/** Desktop gets the assistant as a side panel; below this it is a bottom sheet. */
const WIDE_QUERY = '(min-width: 1024px)'

const nf = new Intl.NumberFormat('en-US')

/**
 * The client portal: the client's leads, read-only, built for cold-calling
 * from a phone. Filters live in the URL so links are shareable and the back
 * button works; `as` (owner preview) rides along on every URL and API call.
 * The list scrolls infinitely (pages of 50 load as the bottom nears) and can
 * be expanded to fill the viewport (Esc or Collapse to exit).
 */
export function PortalScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname() || '/portal'
  const as = params.get('as')
  // Paging is the infinite list's job; the URL never pins a page.
  const filters = useMemo(() => ({ ...filtersFromParams(params), page: 1 }), [params])
  const now = useNow()

  const go = useCallback(
    (next: PortalFilters, mode: 'push' | 'replace' = 'push') => {
      const href = portalHref({ ...next, page: 1 }, as).replace(/^\/portal/, pathname)
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
      go({ ...filters, q }, 'replace')
    }, 250)
    return () => clearTimeout(t)
  }, [q, filters, go])

  const active = usePortalLeadsInfinite(filters, as)
  // The other tabs' counts, as they would read if switched to now (always two: a fixed number of hooks).
  const [otherA, otherB] = TABS.map((t) => t.tab).filter((t) => t !== filters.tab)
  const a = usePortalLeads(switchTab(filters, otherA), as)
  const b = usePortalLeads(switchTab(filters, otherB), as)
  const totals = {
    [filters.tab]: active.data?.total,
    [otherA]: a.data?.total,
    [otherB]: b.data?.total,
  } as Record<PortalTab, number | undefined>
  // Call sheets only show once a sheet is shared with this client (or it is the open tab). Counted with no
  // search, region or phone filter, so a search on another tab never hides the tab.
  const anySheet = usePortalLeads({ ...defaultFilters('sheet'), hasPhone: false }, as)
  const tabs = TABS.filter((t) => t.tab !== 'sheet' || filters.tab === 'sheet' || (anySheet.data?.total ?? 0) > 0)

  const data = active.data
  const regions = useMemo(() => {
    const r = data?.regions ?? []
    return filters.region && !r.includes(filters.region) ? [filters.region, ...r] : r
  }, [data?.regions, filters.region])

  // A new filter set starts the list over: back to its top.
  const listKey = portalHref(filters, as)
  const firstKey = useRef(listKey)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (firstKey.current === listKey) return
    firstKey.current = listKey
    if (scroller) scroller.scrollTop = 0
  }, [listKey, scroller])

  const wide = useMediaQuery(WIDE_QUERY)
  const [agentOpen, setAgentOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Expanded: Esc collapses; the page behind doesn't scroll.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [expanded])

  const filtered = Boolean(filters.q || filters.region || filters.repliedPositive || filters.hasPhone)
  const hasCompanyLines = useMemo(() => active.rows.some((l) => l.phone && l.phone_type === 'company'), [active.rows])

  const results =
    active.error && !data ? (
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
      <div className={cn('flex flex-col gap-3 transition-opacity', active.isValidating && !active.loadingMore && 'opacity-70')}>
        {active.error && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert">
            Could not load more. Showing what loaded so far.
            <Button variant="ghost" size="sm" className="h-9 text-destructive" onClick={() => void active.mutate()}>
              <RotateCw /> Retry
            </Button>
          </div>
        )}
        <div className={cn('hidden md:block', expanded ? 'glass rounded-2xl' : 'glass overflow-clip rounded-2xl')}>
          <LeadsTable rows={active.rows} now={now} stickyTop={expanded ? 'top-0' : 'top-[calc(var(--portal-header-h)+env(safe-area-inset-top))]'} />
        </div>
        <div className="flex flex-col gap-3 md:hidden">
          {active.rows.map((l) => (
            <LeadCard key={`${l.kind}:${l.id}`} lead={l} now={now} />
          ))}
        </div>
        <ListFooter
          shown={active.rows.length}
          total={active.total}
          loadingMore={active.loadingMore}
          reachedEnd={active.reachedEnd}
          onMore={active.loadMore}
          root={expanded ? scroller : null}
          disabled={Boolean(active.error)}
        />
      </div>
    )

  return (
    <div className={cn('mx-auto grid w-full max-w-[1600px] gap-6', agentOpen && wide && 'lg:grid-cols-[minmax(0,1fr)_400px]')}>
      <section className="flex min-w-0 flex-col gap-4">
        {/* Today's signal accounts and the week's scoreboard sit above the campaign lead lists. */}
        {!expanded && <SignalsSection as={as} />}
        {/* Tabs */}
        {!expanded && (
          <div className="flex items-center justify-between gap-3">
            <div role="tablist" aria-label="Lead source" className="glass flex min-w-0 gap-1 rounded-2xl p-1">
              {tabs.map(({ tab, label }) => {
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
        )}

        <div
          data-testid="portal-results"
          data-expanded={expanded ? 'true' : 'false'}
          role={expanded ? 'dialog' : undefined}
          aria-modal={expanded ? true : undefined}
          aria-label={expanded ? 'Leads, expanded' : undefined}
          className={cn('flex min-w-0 flex-col gap-3', expanded && 'fixed inset-0 z-50 bg-background px-3 pt-[calc(env(safe-area-inset-top)+12px)] pb-3 md:px-5 md:pt-4')}
        >
          {/* Filters */}
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
            <div className="relative col-span-2 min-w-0 md:max-w-sm md:flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 z-10 size-4 -translate-y-1/2 text-fg-46" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, company, phone, city"
                aria-label="Search leads"
                enterKeyHint="search"
                className="glass h-12 w-full rounded-2xl pr-11 pl-10 text-[15px] text-fg outline-none placeholder:text-fg-24 focus-visible:ring-2 focus-visible:ring-ring md:h-10 md:rounded-xl md:text-[14px] [&::-webkit-search-cancel-button]:hidden"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => setQ('')}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-1 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-xl text-fg-46 hover:text-fg md:size-8"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
            <LabeledSelect label="Region" value={filters.region} onChange={(v) => go({ ...filters, region: v })}>
              <option value="">All</option>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </LabeledSelect>
            <LabeledSelect label="Sort" ariaLabel="Sort by" value={filters.sort} onChange={(v) => go({ ...filters, sort: v as PortalSort })}>
              {(Object.keys(SORT_LABEL) as PortalSort[]).map((s) => (
                <option key={s} value={s}>
                  {SORT_LABEL[s]}
                </option>
              ))}
            </LabeledSelect>
            <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 md:contents">
              <Toggle pressed={filters.hasPhone} onChange={(v) => go({ ...filters, hasPhone: v })}>
                Has phone
              </Toggle>
              <Toggle pressed={filters.repliedPositive} onChange={(v) => go({ ...filters, repliedPositive: v })}>
                Replied (positive)
              </Toggle>
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-pressed={expanded}
                className="glass ml-auto inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-medium text-fg-70 outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:text-[13px]"
              >
                {expanded ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
                {expanded ? 'Collapse' : 'Expand'}
              </button>
            </div>
          </div>

          {data && data.rows.length > 0 && (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[12px] text-fg-46">
              <span className="tabular-nums" aria-live="polite">
                Showing {nf.format(active.rows.length)} of {nf.format(active.total)}
              </span>
              {hasCompanyLines && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Building2 className="size-3.5 shrink-0" aria-hidden />
                  Numbers are company lines — ask for the person by name
                </span>
              )}
            </div>
          )}

          {expanded ? (
            <div ref={setScroller} data-testid="portal-scroller" className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-2xl">
              {results}
            </div>
          ) : (
            results
          )}
        </div>
      </section>

      {/* Assistant: side panel on desktop, bottom sheet on phones/tablets. */}
      {wide && agentOpen && (
        <aside
          className="glass sticky top-[calc(var(--portal-header-h)+1rem)] flex h-[calc(100dvh-var(--portal-header-h)-2rem)] min-h-0 flex-col overflow-hidden rounded-2xl"
          aria-label="Assistant"
        >
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
      {!agentOpen && !expanded && (
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

/** A native select with its label inside the control (stays readable at 375 px). */
function LabeledSelect({
  label,
  ariaLabel,
  value,
  onChange,
  children,
}: {
  label: string
  ariaLabel?: string
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="glass relative flex h-12 min-w-0 cursor-pointer md:max-w-[16rem] items-center gap-2 rounded-xl pr-8 pl-3 text-[14px] focus-within:ring-2 focus-within:ring-ring md:h-9 md:text-[13px]">
      <span className="shrink-0 text-fg-46">{label}</span>
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-full min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent font-medium text-fg outline-none md:max-w-[12rem] [&>option]:bg-background"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-46" aria-hidden />
    </label>
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

/**
 * The bottom of the list: an invisible sentinel that asks for the next page
 * when it nears the viewport (or the expanded view's scroller), a "Loading
 * more…" row while it loads, and an end marker once everything is shown.
 */
function ListFooter({
  shown,
  total,
  loadingMore,
  reachedEnd,
  onMore,
  root,
  disabled,
}: {
  shown: number
  total: number
  loadingMore: boolean
  reachedEnd: boolean
  onMore: () => void
  root: Element | null
  disabled: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reachedEnd || disabled || typeof IntersectionObserver === 'undefined') return
    // Re-created after each page lands, so a sentinel that is still on screen asks again.
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { root, rootMargin: '0px 0px 800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [root, onMore, reachedEnd, disabled, loadingMore])
  return (
    <div className="flex flex-col items-center pb-24 md:pb-4">
      <div ref={ref} data-testid="portal-sentinel" aria-hidden className="h-px w-full" />
      {loadingMore ? (
        <div role="status" className="flex h-11 items-center gap-2 text-[13px] text-fg-46">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading more…
        </div>
      ) : reachedEnd ? (
        <div className="flex h-11 items-center text-[12px] text-fg-24 tabular-nums">{shown === total ? `All ${nf.format(total)} leads shown` : `${nf.format(shown)} leads`}</div>
      ) : (
        <button type="button" onClick={onMore} className="h-11 rounded-xl px-4 text-[13px] text-fg-46 hover:text-fg">
          Load more
        </button>
      )}
    </div>
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
