import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AgentChat } from '@/components/agent/AgentChat'
import { LumeLoader } from '@/components/agent/LumeLoader'

export const metadata: Metadata = { title: 'Agent' }

// AgentChat reads `?c=` (useSearchParams), which needs a Suspense boundary on a static page.
export default function AgentPage() {
  return (
    <Suspense fallback={<LumeLoader label="Waking Lume" className="fixed inset-0 z-10 bg-background" />}>
      <AgentChat />
    </Suspense>
  )
}
