import type { Metadata } from 'next'
import { AgentChat } from '@/components/agent/AgentChat'

export const metadata: Metadata = { title: 'Agent' }

export default function AgentPage() {
  return <AgentChat />
}
