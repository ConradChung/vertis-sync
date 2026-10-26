import { Bot, FlaskConical, LayoutDashboard, Megaphone, Repeat2, ShieldCheck, Upload, Users, type LucideIcon } from 'lucide-react'

/** Primary navigation. `primary` tabs sit in the phone bottom bar; the rest live under More. */
export const TABS: readonly { href: string; label: string; icon: LucideIcon; primary?: boolean }[] = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard, primary: true },
  { href: '/import', label: 'Import', icon: Upload },
  { href: '/validate', label: 'Validate', icon: ShieldCheck },
  { href: '/rotate', label: 'Rotate', icon: Repeat2 },
  { href: '/campaigns', label: 'Campaigns', icon: Megaphone, primary: true },
  { href: '/crm', label: 'CRM', icon: Users, primary: true },
  { href: '/agent', label: 'Agent', icon: Bot, primary: true },
  { href: '/playground', label: 'Playground', icon: FlaskConical },
]

export const isActiveTab = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`)
