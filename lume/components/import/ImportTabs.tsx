import Link from 'next/link'
import { cn } from '@/lib/utils'

/** Import's two views: the intakes and orders, and the persistent lead lists. */
export function ImportTabs({ active }: { active: 'intake' | 'leads' }) {
  const tab = (key: 'intake' | 'leads', href: string, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? 'page' : undefined}
      className={cn('rounded-full px-3 py-1 text-[12.5px] transition-colors', active === key ? 'bg-primary text-primary-foreground' : 'text-fg-46 hover:text-fg')}
    >
      {label}
    </Link>
  )
  return (
    <nav aria-label="Import views" className="mb-4 flex w-fit rounded-full border border-line p-0.5">
      {tab('intake', '/import', 'Intake & orders')}
      {tab('leads', '/import/leads', 'Leads')}
    </nav>
  )
}
