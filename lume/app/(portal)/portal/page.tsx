import { Suspense } from 'react'
import { PortalScreen } from '@/components/portal/PortalScreen'

/** /portal — the client's read-only lead list (auth + scoping: middleware and /api/portal/**). */
export default function PortalPage() {
  return (
    <Suspense fallback={null}>
      <PortalScreen />
    </Suspense>
  )
}
