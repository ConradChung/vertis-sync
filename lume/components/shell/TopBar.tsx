'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { useSWRConfig } from 'swr'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { CommandPalette } from '@/components/shell/CommandPalette'
import { MobileNav } from '@/components/shell/MobileNav'
import { OperatorChip } from '@/components/shell/OperatorChip'
import { cn } from '@/lib/utils'
import { prefetchTab, TAB_KEYS } from '@/lib/prefetch/tabs'
import { isActiveTab } from '@/components/shell/tabs'
import { FLOW, TOOLS, tabForChord } from '@/components/shell/nav'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Kbd } from '@/components/ui/kbd'
import { LumeMark } from './LumeMark'

export { TABS, isActiveTab } from '@/components/shell/tabs'

/**
 * Desktop chrome is two small corner pieces, so the page gets the width:
 * the navigation square at top left (Launcher) and search / theme at top
 * right. Page content scrolls beneath them.
 *
 * `operator`: the Grok Bot's vertical name (or "Master") when an operator key
 * holds the session, from the server layout; shown as a small chip.
 */
export function TopBar({ operator = null }: { operator?: string | null } = {}) {
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
    <>
    {/* Phones get a slim header + bottom tab bar (MobileNav); the corner controls below are sm and up. */}
    <MobileNav pathname={pathname} warm={warm} operator={operator} />
    <Launcher pathname={pathname} warm={warm} />
    <div className="glass fixed top-4 right-4 z-30 flex h-11 items-center gap-0.5 rounded-2xl bg-(--bar-fill) px-1 shadow-(--bar-shadow) backdrop-blur-xl max-sm:hidden">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event('lume:open-palette'))}
        aria-label="Search"
        title="Search (⌘K)"
        className="grid size-9 place-items-center rounded-xl text-fg-70 outline-none hover:bg-secondary hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="size-[17px]" strokeWidth={1.75} />
      </button>
      {operator && <OperatorChip label={operator} className="mx-1" />}
      <ThemeToggle />
    </div>
    <CommandPalette />
    </>
  )
}

/**
 * Desktop navigation: a glass square in the top-left corner (the Lume mark)
 * with the current page beside it. It opens a panel with the numbered flow
 * (1 Import … 5 Campaigns) and the tools as a grid. Alt + a step's number or a
 * tool's letter jumps there from anywhere, without opening the panel.
 */
function Launcher({ pathname, warm }: { pathname: string; warm: (href: string) => void }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const t = tabForChord(e.code)
      if (!t) return
      // Letters stay typeable (⌥-characters) inside text fields; numbers always jump.
      const el = e.target as HTMLElement | null
      const editing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      if (editing && !t.step) return
      e.preventDefault()
      router.push(t.href)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router])

  const current = [...FLOW, ...TOOLS].find((t) => isActiveTab(pathname, t.href))

  return (
    <div className="fixed top-4 left-4 z-30 flex items-center gap-3 max-sm:hidden">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label="Open navigation"
          title="Navigate"
          className={cn(
            'glass grid size-11 place-items-center rounded-2xl bg-(--bar-fill) text-fg shadow-(--bar-shadow) backdrop-blur-xl outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring',
            open && 'bg-secondary'
          )}
        >
          <LumeMark className="h-3.5 w-auto" />
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-[400px] gap-0 rounded-2xl p-2">
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.12em] text-fg-46 uppercase">Flow</p>
          <nav aria-label="Flow" className="flex flex-col">
            {FLOW.map((t) => {
              const active = isActiveTab(pathname, t.href)
              const Icon = t.icon
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  onPointerEnter={() => warm(t.href)}
                  onFocus={() => warm(t.href)}
                  className={cn(
                    'group flex h-10 items-center gap-3 rounded-xl px-2.5 text-[14px] text-fg outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring',
                    active && 'bg-primary text-primary-foreground hover:bg-primary light:ring-1 light:ring-(--lime-edge)'
                  )}
                >
                  <span aria-hidden className={cn('grid size-6 place-items-center rounded-lg border border-line font-mono text-[12px] text-fg-70', active && 'border-black/20 text-primary-foreground')}>{t.step}</span>
                  <Icon className="size-4" strokeWidth={1.75} aria-hidden />
                  <span className="flex-1">{t.label}</span>
                  <Kbd aria-hidden className={cn(active && 'bg-black/10 text-primary-foreground')}>⌥{t.key}</Kbd>
                </Link>
              )
            })}
          </nav>
          <div className="my-2 h-px bg-line" />
          <p className="px-2.5 pb-1 text-[11px] font-medium tracking-[0.12em] text-fg-46 uppercase">Tools</p>
          <nav aria-label="Tools" className="grid grid-cols-4 gap-1">
            {TOOLS.map((t) => {
              const active = isActiveTab(pathname, t.href)
              const Icon = t.icon
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  onPointerEnter={() => warm(t.href)}
                  onFocus={() => warm(t.href)}
                  title={t.key ? `${t.label} (⌥${t.key})` : t.label}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-xl px-1 py-2.5 text-[12px] text-fg-70 outline-none hover:bg-secondary hover:text-fg focus-visible:ring-2 focus-visible:ring-ring',
                    active && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground light:ring-1 light:ring-(--lime-edge)'
                  )}
                >
                  <Icon className="size-5" strokeWidth={1.75} aria-hidden />
                  {t.label}
                </Link>
              )
            })}
          </nav>
          <p className="px-2.5 pt-2 pb-1 text-[11.5px] text-fg-46">⌥ + number or letter jumps there from anywhere · ⌘K searches</p>
        </PopoverContent>
      </Popover>
      {current && (
        <span className="text-[14px] font-medium text-fg">
          {current.step && <span className="mr-1.5 font-mono text-fg-46">{current.step}</span>}
          {current.label}
        </span>
      )}
    </div>
  )
}
