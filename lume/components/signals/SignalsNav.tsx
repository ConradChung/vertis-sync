import Link from 'next/link'
import { cn } from '@/lib/utils'

const VIEWS = [
  { id: 'inbox', href: '/signals', label: 'Inbox' },
  { id: 'hiring', href: '/signals/hiring', label: 'Hiring' },
  { id: 'influencers', href: '/signals/influencers', label: 'Influencers' },
] as const

/** The views inside Signals, as plain text links in the page head (the current one is the bright one). */
export function SignalsNav({ current }: { current: (typeof VIEWS)[number]['id'] }) {
  return (
    <nav aria-label="Signals views" className="flex items-center gap-6 text-[14px]">
      {VIEWS.map((v) => (
        <Link key={v.id} href={v.href} aria-current={v.id === current ? 'page' : undefined} className={cn('outline-none hover:text-fg focus-visible:underline', v.id === current ? 'font-medium text-fg' : 'text-fg-46')}>
          {v.label}
        </Link>
      ))}
    </nav>
  )
}
