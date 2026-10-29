'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Ellipsis, Search } from 'lucide-react'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { OperatorChip } from '@/components/shell/OperatorChip'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { TABS, isActiveTab } from '@/components/shell/tabs'
import { cn } from '@/lib/utils'
import { LumeMark } from './LumeMark'

const openPalette = () => window.dispatchEvent(new Event('lume:open-palette'))

/**
 * Phone navigation (below `sm`): a slim glass header (logo, current page,
 * search, theme) and a floating bottom tab bar with the four primary tabs plus
 * More, which opens a sheet with the rest. Both respect the safe-area insets.
 */
/**
 * Tracks the visual viewport so phone layouts can size to the space above the
 * on-screen keyboard: sets `--vvh` (px) on <html>, and `data-kb` while the
 * keyboard is open (the bottom tab bar hides then).
 */
function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const update = () => {
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      const kb = window.innerHeight - vv.height > 150 && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639.98px)').matches
      if (kb) root.dataset.kb = '1'
      else delete root.dataset.kb
    }
    update()
    vv.addEventListener('resize', update)
    return () => {
      vv.removeEventListener('resize', update)
      root.style.removeProperty('--vvh')
      delete root.dataset.kb
    }
  }, [])
}

export function MobileNav({
  pathname,
  warm,
  operator = null,
}: {
  pathname: string
  warm: (href: string) => void
  /** Grok Bot operator chip label (vertical name or "Master"), when one holds the session. */
  operator?: string | null
}) {
  useVisualViewport()
  const [more, setMore] = useState(false)
  useEffect(() => setMore(false), [pathname])
  const current = TABS.find((t) => isActiveTab(pathname, t.href))
  const primary = TABS.filter((t) => t.primary)
  const rest = TABS.filter((t) => !t.primary)
  const restActive = rest.some((t) => isActiveTab(pathname, t.href))

  return (
    <>
      <header className="mobile-top glass fixed inset-x-3 z-30 flex h-12 items-center gap-1 rounded-full bg-(--bar-fill) pr-1.5 pl-4 shadow-(--bar-shadow) backdrop-blur-xl sm:hidden">
        <Link href="/overview" className="brand shrink-0" aria-label="Lume home">
          <LumeMark className="h-3.5 w-auto shrink-0 text-fg" />
          <span>lume</span>
        </Link>
        {current && <span className="ml-2 truncate border-l border-border pl-2.5 text-[14px] text-fg-70">{current.label}</span>}
        <span className="flex-1" />
        {operator && <OperatorChip label={operator} className="max-w-[9rem]" />}
        <button type="button" onClick={openPalette} aria-label="Search" className="grid size-10 place-items-center rounded-full text-fg-70 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
          <Search className="size-[18px]" strokeWidth={1.75} />
        </button>
        <ThemeToggle />
      </header>

      <nav aria-label="Primary" className="mobile-bottom glass fixed inset-x-3 z-30 flex h-16 items-stretch rounded-[22px] bg-(--bar-fill) p-1.5 shadow-(--bar-shadow) backdrop-blur-xl sm:hidden">
        {primary.map((t) => {
          const active = isActiveTab(pathname, t.href)
          const Icon = t.icon
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              onPointerDown={() => warm(t.href)}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-[10.5px] font-medium text-fg-46 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                active && 'bg-primary text-primary-foreground dark:shadow-(--primary-glow) light:ring-1 light:ring-(--lime-edge)'
              )}
            >
              <Icon className="size-5" strokeWidth={active ? 2 : 1.75} aria-hidden />
              {t.label}
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMore(true)}
          aria-haspopup="dialog"
          aria-expanded={more}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-[10.5px] font-medium text-fg-46 outline-none focus-visible:ring-2 focus-visible:ring-ring',
            restActive && 'bg-primary text-primary-foreground light:ring-1 light:ring-(--lime-edge)'
          )}
        >
          <Ellipsis className="size-5" strokeWidth={1.75} aria-hidden />
          {restActive ? TABS.find((t) => isActiveTab(pathname, t.href))?.label : 'More'}
        </button>
      </nav>

      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" className="rounded-t-[24px] px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)]">
          <SheetTitle className="px-1 text-[13px] font-medium tracking-wide text-fg-46 uppercase">More</SheetTitle>
          <ul className="grid grid-cols-2 gap-2">
            {rest.map((t) => {
              const active = isActiveTab(pathname, t.href)
              const Icon = t.icon
              return (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    onPointerDown={() => warm(t.href)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-14 items-center gap-3 rounded-2xl border border-line px-4 text-[15px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active && 'border-transparent bg-primary text-primary-foreground'
                    )}
                  >
                    <Icon className="size-5" strokeWidth={1.75} aria-hidden />
                    {t.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  )
}
