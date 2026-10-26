import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PlaygroundScreen } from '@/components/playground/PlaygroundScreen'

export const metadata: Metadata = { title: 'Playground' }

// PlaygroundScreen reads `?d=` (useSearchParams), which needs a Suspense boundary on a static page.
export default function PlaygroundPage() {
  return (
    <Suspense>
      <PlaygroundScreen />
    </Suspense>
  )
}
