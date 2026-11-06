import { Bot, ClipboardCheck, FlaskConical, LayoutDashboard, Megaphone, Repeat2, Settings, ShieldCheck, Sheet, Upload, UserSearch, Users, type LucideIcon } from 'lucide-react'

/** Primary navigation. `primary` tabs sit in the phone bottom bar; the rest live under More. */
export const TABS: readonly { href: string; label: string; icon: LucideIcon; primary?: boolean }[] = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard, primary: true },
  { href: '/import', label: 'Import', icon: Upload },
  { href: '/import/leads', label: 'Leads', icon: Sheet },
  { href: '/validate', label: 'Validate', icon: ShieldCheck },
  { href: '/rotate', label: 'Rotate', icon: Repeat2 },
  { href: '/campaigns', label: 'Campaigns', icon: Megaphone, primary: true },
  { href: '/crm', label: 'CRM', icon: Users, primary: true },
  { href: '/agent', label: 'Agent', icon: Bot, primary: true },
  { href: '/influencers', label: 'Influencers', icon: UserSearch },
  { href: '/playground', label: 'Playground', icon: FlaskConical },
  { href: '/operator', label: 'Operator', icon: ClipboardCheck },
  { href: '/settings', label: 'Settings', icon: Settings },
]

/** Leads lives under /import but is its own tab: Import isn't highlighted on it. */
export const isActiveTab = (pathname: string, href: string) =>
  href === '/import' && (pathname === '/import/leads' || pathname.startsWith('/import/leads/'))
    ? false
    : pathname === href || pathname.startsWith(`${href}/`)
