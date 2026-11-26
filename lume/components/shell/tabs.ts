import { Bot, CalendarDays, ClipboardCheck, FlaskConical, Inbox, Megaphone, Radar, Repeat2, Settings, ShieldCheck, Sheet, Sun, Upload, Users, type LucideIcon } from 'lucide-react'

/** The tab that carries the pending-approvals badge. */
export const APPROVALS_HREF = '/actions'

/**
 * Where a tab sits (owner, 2026-11-26: the app opens on the path to a paying
 * customer). `primary` is the daily work and the phone bottom bar; `volume`
 * is the numbered lead-volume flow, collapsed in the menu; `admin` is the
 * setup around it; `more` pages keep their URL and ⌘K entry but have no menu slot.
 */
export type TabGroup = 'primary' | 'volume' | 'admin' | 'more'

export type Tab = { href: string; label: string; icon: LucideIcon; group: TabGroup; primary?: boolean }

/** Navigation, in menu order within each group. `primary` tabs sit in the phone bottom bar; the rest live under More. */
export const TABS: readonly Tab[] = [
  // Until /today, /signals and /replies exist these point at the pages that do the job now.
  { href: '/overview', label: 'Today', icon: Sun, group: 'primary', primary: true },
  { href: '/signals/hiring', label: 'Signals', icon: Radar, group: 'primary', primary: true },
  { href: '/crm', label: 'Pipeline', icon: Users, group: 'primary', primary: true },
  { href: '/actions', label: 'Replies', icon: Inbox, group: 'primary', primary: true },
  { href: '/agent', label: 'Agent', icon: Bot, group: 'primary', primary: true },
  { href: '/import', label: 'Import', icon: Upload, group: 'volume' },
  { href: '/import/leads', label: 'Leads', icon: Sheet, group: 'volume' },
  { href: '/progress', label: 'Progress', icon: ShieldCheck, group: 'volume' },
  { href: '/rotate', label: 'Rotate', icon: Repeat2, group: 'volume' },
  { href: '/campaigns', label: 'Campaigns', icon: Megaphone, group: 'volume' },
  { href: '/playground', label: 'Playground', icon: FlaskConical, group: 'admin' },
  { href: '/operator', label: 'Operator', icon: ClipboardCheck, group: 'admin' },
  { href: '/settings', label: 'Settings', icon: Settings, group: 'admin' },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays, group: 'more' },
]

/** Leads lives under /import but is its own tab: Import isn't highlighted on it. */
export const isActiveTab = (pathname: string, href: string) =>
  href === '/import' && (pathname === '/import/leads' || pathname.startsWith('/import/leads/'))
    ? false
    : pathname === href || pathname.startsWith(`${href}/`)
