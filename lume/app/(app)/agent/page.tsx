import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AgentChat } from '@/components/agent/AgentChat'

export const metadata: Metadata = { title: 'Agent' }

// AgentChat reads `?c=` (useSearchParams), which needs a Suspense boundary on a static page.
export default function AgentPage() {
  return (
    <Suspense>
      <AgentChat />
    </Suspense>
  )
}
