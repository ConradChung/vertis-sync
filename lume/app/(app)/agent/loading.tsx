import { LumeLoader } from '@/components/agent/LumeLoader'

/** Route transition into the agent: its own loader on the solid agent background. */
export default function AgentLoading() {
  return <LumeLoader label="Waking Lume" className="fixed inset-0 z-10 bg-background" />
}
