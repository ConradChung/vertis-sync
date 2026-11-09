import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { ProgressScreen } from '@/components/progress/ProgressScreen'
import { ProgressSkeleton } from '@/components/progress/ProgressBoard'

export const metadata: Metadata = { title: 'Progress' }

export default function ProgressPage() {
  return (
    <>
      <PageHead eyebrow="Step 3" title="Progress" sub="One CSV at a time, step by step — every choice here is the same tap as in Telegram." />
      {/* useSearchParams (?run= / ?gate=) needs a Suspense boundary. */}
      <Suspense fallback={<ProgressSkeleton />}>
        <ProgressScreen />
      </Suspense>
    </>
  )
}
