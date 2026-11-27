import type { ReactNode } from 'react'
import { PageHead } from '@/components/shell/PageHead'
import { SignalsNav } from '@/components/signals/SignalsNav'

/** Every Signals view shares the title and the source tabs: All, Post comments, Reddit, Hiring, Influencers. */
export default function SignalsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHead title="Signals" className="mb-4" />
      <SignalsNav />
      {children}
    </>
  )
}
