import type { Metadata } from 'next'
import { Suspense, type CSSProperties } from 'react'
import { PortalHeader } from '@/components/portal/PortalHeader'

// `absolute`: the client never sees the owner's "· lume" title suffix.
export const metadata: Metadata = { title: { absolute: 'Leads' }, robots: { index: false, follow: false } }

/**
 * The client portal's own shell. A sibling route group of `(app)`, so none of
 * the owner's chrome (TopBar, MobileNav, palette, orb) is rendered here; only
 * the root layout's theme + background wrap it.
 */
export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-dvh" style={{ '--portal-header-h': '64px' } as CSSProperties}>
      {/* useSearchParams (owner preview `?as=`) needs a Suspense boundary for static prerendering. */}
      <Suspense fallback={<div className="h-16" />}>
        <PortalHeader />
      </Suspense>
      <main className="px-4 pt-4 pb-8 md:px-8 md:pt-6">{children}</main>
    </div>
  )
}
