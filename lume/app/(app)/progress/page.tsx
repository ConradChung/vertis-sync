import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { ValidateScreen } from '@/components/validate/ValidateScreen'
import { ValidateSkeleton } from '@/components/validate/ValidateView'

export const metadata: Metadata = { title: 'Progress' }

export default function ProgressPage() {
  return (
    <>
      <PageHead eyebrow="Step 3" title="Progress" sub="Everything running right now, and every gate waiting on you — the same buttons as Telegram." />
      {/* useSearchParams (the ?gate= deep link) needs a Suspense boundary. */}
      <Suspense fallback={<ValidateSkeleton />}>
        <ValidateScreen />
      </Suspense>
    </>
  )
}
