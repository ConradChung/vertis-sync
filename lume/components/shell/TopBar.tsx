'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect } from 'react'
import { useSWRConfig } from 'swr'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { CommandPalette } from '@/components/shell/CommandPalette'
import { cn } from '@/lib/utils'
import { prefetchTab, TAB_KEYS } from '@/lib/prefetch/tabs'

export const TABS = [
  { href: '/overview', label: 'Overview' },
  { href: '/import', label: 'Import' },
  { href: '/validate', label: 'Validate' },
  { href: '/rotate', label: 'Rotate' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/crm', label: 'CRM' },
  { href: '/agent', label: 'Agent' },
  { href: '/playground', label: 'Playground' },
] as const

/**
 * Floating glass tab bar: a centred pill detached from the edges (full width
 * minus a 12 px gutter on phones, tabs scroll inside it). Logo mark at left,
 * theme toggle at right. Active tab is a lime pill with black/ink text (light
 * adds a thin olive edge). Page content scrolls beneath it.
 */
export function TopBar() {
  const pathname = usePathname()
  const { cache, mutate } = useSWRConfig()
  const warm = useCallback(
    (href: string) => prefetchTab(href, { mutate, hasData: (key) => cache.get(key)?.data !== undefined }),
    [cache, mutate]
  )

  // Once the first screen has settled, quietly warm the other tabs so the
  // first click on each renders from cache (and refreshes in the background).
  useEffect(() => {
    const run = () => {
      for (const href of Object.keys(TAB_KEYS)) if (!pathname.startsWith(href)) warm(href)
    }
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(run, { timeout: 4_000 })
      return () => w.cancelIdleCallback?.(id)
    }
    const t = setTimeout(run, 1_500)
    return () => clearTimeout(t)
    // First mount only: later navigations are covered by hover/focus warming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <header className="glass fixed inset-x-3 top-4 z-30 mx-auto flex h-14 items-center gap-1 rounded-full bg-(--bar-fill) py-2 pr-2 pl-4 shadow-(--bar-shadow) backdrop-blur-xl sm:inset-x-0 sm:w-fit sm:max-w-[calc(100%-2rem)]">
      <Link href="/overview" className="brand mr-2 shrink-0" aria-label="Lume home">
        <span className="inline-block size-3 rounded-[3px] bg-primary dark:shadow-(--primary-glow) light:ring-1 light:ring-(--lime-edge)" aria-hidden />
        <span className="max-sm:sr-only">lume</span>
      </Link>

      <nav aria-label="Primary" className="nav -my-2 flex min-w-0 flex-1 items-center gap-0.5 py-2 max-sm:-mx-1 max-sm:overflow-x-auto max-sm:px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              onPointerEnter={() => warm(tab.href)}
              onFocus={() => warm(tab.href)}
              className={cn(
                'relative inline-flex h-9 shrink-0 items-center rounded-full bg-transparent px-3.5 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:px-3',
                active &&
                  'bg-primary font-medium text-primary-foreground hover:bg-primary hover:text-primary-foreground dark:shadow-(--primary-glow) max-sm:shadow-none light:ring-1 light:ring-(--lime-edge)'
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>

      <div className="ml-1 shrink-0 border-l border-border pl-1">
        <ThemeToggle />
      </div>
      <CommandPalette />
    </header>
  )
}
