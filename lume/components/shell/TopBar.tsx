'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

export const TABS = [
  { href: '/overview', label: 'Overview' },
  { href: '/import', label: 'Import' },
  { href: '/validate', label: 'Validate' },
  { href: '/rotate', label: 'Rotate' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/agent', label: 'Agent' },
] as const

/** Flat horizontal top nav: black bar, hairline bottom border, active tab violet. */
export function TopBar() {
  const pathname = usePathname()

  return (
    <header className="fixed inset-x-0 top-0 z-20 border-b border-border bg-background">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6 max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-2 max-sm:px-4 max-sm:py-3">
        <Link href="/overview" className="brand" aria-label="Lume home">
          <span className="inline-block size-3 rounded-[3px] bg-violet" aria-hidden />
          lume
        </Link>

        <nav aria-label="Primary" className="nav -mb-px flex h-full flex-1 gap-1 overflow-x-auto max-sm:order-3 max-sm:basis-full max-sm:h-9">
          {TABS.map((tab) => {
            const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center border-b-2 border-transparent px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:px-2',
                  active && 'border-violet text-foreground'
                )}
              >
                {tab.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
