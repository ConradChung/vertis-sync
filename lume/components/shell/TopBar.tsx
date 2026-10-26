'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { cn } from '@/lib/utils'

export const TABS = [
  { href: '/overview', label: 'Overview' },
  { href: '/import', label: 'Import' },
  { href: '/validate', label: 'Validate' },
  { href: '/rotate', label: 'Rotate' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/agent', label: 'Agent' },
] as const

/** Sticky glass top nav. Active tab is a primary pill (lime in dark, forest green with a lime underline in light). */
export function TopBar() {
  const pathname = usePathname()

  return (
    <header className="glass fixed inset-x-0 top-0 z-20 border-x-0! border-t-0!">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6 max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-2 max-sm:px-4 max-sm:py-3">
        <Link href="/overview" className="brand" aria-label="Lume home">
          <span className="inline-block size-3 rounded-[3px] bg-primary dark:shadow-(--primary-glow)" aria-hidden />
          lume
        </Link>

        <nav aria-label="Primary" className="nav flex flex-1 items-center gap-1 overflow-x-auto max-sm:order-3 max-sm:basis-full">
          {TABS.map((tab) => {
            const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative inline-flex h-8 items-center rounded-full px-3.5 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:px-2.5',
                  active &&
                    'bg-primary font-medium text-primary-foreground hover:bg-primary hover:text-primary-foreground dark:shadow-(--primary-glow) light:after:absolute light:after:inset-x-3.5 light:after:bottom-[3px] light:after:h-0.5 light:after:rounded-full light:after:bg-lime'
                )}
              >
                {tab.label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center max-sm:order-2">
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
