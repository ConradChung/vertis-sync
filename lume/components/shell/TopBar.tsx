'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { OrbState } from '@/components/orb/Orb'

// WebGL only exists in the browser; render a same-size placeholder on the server.
const Orb = dynamic(() => import('@/components/orb/Orb'), {
  ssr: false,
  loading: () => <div className="orb-placeholder" aria-hidden />,
})

export const TABS = [
  { href: '/overview', label: 'Overview' },
  { href: '/import', label: 'Import' },
  { href: '/validate', label: 'Validate' },
  { href: '/rotate', label: 'Rotate' },
  { href: '/campaigns', label: 'Campaigns' },
] as const

export type TopBarProps = {
  /** Agent state for the orb. Task 14 wires this to `agent_runs`. */
  orbState?: OrbState
}

export function TopBar({ orbState = 'idle' }: TopBarProps) {
  const pathname = usePathname()

  return (
    <header className="topbar fixed inset-x-0 top-0 z-20 flex h-(--topbar-h) items-center gap-7 px-8 max-[1000px]:gap-3 max-[1000px]:px-[18px]">
      <Link href="/overview" className="brand" aria-label="Lume home">
        lume
      </Link>

      <nav aria-label="Primary" className="nav flex flex-1 gap-1">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'rounded-control px-3.5 py-2.5 text-[13px] text-fg-46 transition-colors duration-200 hover:bg-white/8 hover:text-fg max-[1000px]:px-2',
                active && 'bg-white/8 text-fg'
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>

      <div className="orb-button ml-auto">
        <Orb compact state={orbState} />
      </div>
    </header>
  )
}
