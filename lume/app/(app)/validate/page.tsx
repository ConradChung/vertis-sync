import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { ValidateScreen } from '@/components/validate/ValidateScreen'
import { ValidateSkeleton } from '@/components/validate/ValidateView'

export const metadata: Metadata = { title: 'Validate' }

export default function ValidatePage() {
  return (
    <>
      <PageHead eyebrow="Stage 2" title="Validate" sub="Every gate waiting on you — the same buttons as Telegram." />
      {/* useSearchParams (the ?gate= deep link) needs a Suspense boundary. */}
      <Suspense fallback={<ValidateSkeleton />}>
        <ValidateScreen />
      </Suspense>
    </>
  )
}
