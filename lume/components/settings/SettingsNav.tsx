import Link from 'next/link'
import { cn } from '@/lib/utils'

/** Settings' sub-pages. */
const PAGES = [
  { href: '/settings/verticals', label: 'Verticals' },
  { href: '/settings/slack', label: 'Slack' },
] as const

export function SettingsNav({ current }: { current: (typeof PAGES)[number]['href'] }) {
  return (
    <nav aria-label="Settings" className="mb-6 flex gap-1 text-sm">
      {PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={p.href === current ? 'page' : undefined}
          className={cn('rounded-md px-3 py-1.5', p.href === current ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  )
}
