'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

export const SIGNAL_TABS = [
  { id: 'all', href: '/signals', label: 'All' },
  { id: 'comments', href: '/signals/comments', label: 'Post comments' },
  { id: 'reddit', href: '/signals/reddit', label: 'Reddit' },
  { id: 'hiring', href: '/signals/hiring', label: 'Hiring' },
  { id: 'influencers', href: '/signals/influencers', label: 'Influencers' },
] as const
export type SignalTab = (typeof SIGNAL_TABS)[number]['id']

/** Which tab a path belongs to (`/signals` and anything unknown under it is All). */
export function tabOf(path: string | null): SignalTab {
  return SIGNAL_TABS.find((t) => t.id !== 'all' && path?.startsWith(t.href))?.id ?? 'all'
}

/**
 * Signals' sub-tabs, one per source, under the page title (rendered once by
 * signals/layout.tsx). Plain text links; the current one is bright and
 * underlined. `current` overrides the path (tests).
 */
export function SignalsNav({ current }: { current?: SignalTab }) {
  const path = usePathname()
  const active = current ?? tabOf(path)
  return (
    <nav aria-label="Signals sources" className="-mx-1 mb-6 flex items-center gap-1 overflow-x-auto text-[14px] [scrollbar-width:none]">
      {SIGNAL_TABS.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={t.id === active ? 'page' : undefined}
          className={cn(
            'shrink-0 rounded-lg px-3 py-1.5 whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
            t.id === active ? 'bg-secondary font-medium text-fg' : 'text-fg-46 hover:text-fg'
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
