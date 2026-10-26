import type { OrbState } from '@/components/orb/Orb'

/** The slice of `agent_runs` the orb reads (RLS lets the owner's browser select it). */
export interface OrbRun {
  id: string
  status: 'running' | 'needs_approval' | 'done' | 'failed'
  tool_calls: unknown[] | null
  approval_action_id?: string | null
}

/** One entry of `agent_runs.tool_calls`, as the run route writes it. */
export interface ToolCallEntry {
  id: string
  name: string
  tier: 'read' | 'low' | 'high'
  input?: unknown
  status: 'running' | 'ok' | 'error'
  ms?: number
  error?: string
  action_id?: string
}

/**
 * Orb state from the latest run: listening (mic open) wins; then
 * needs_approval (action still awaiting) → amber; running with a tool in flight → acting;
 * running → thinking; anything else idle.
 */
export function orbStateFrom(
  run: OrbRun | null,
  opts: { listening?: boolean; approvalSettled?: boolean } = {}
): OrbState {
  if (opts.listening) return 'listening'
  if (!run) return 'idle'
  // A run stays `needs_approval` after the owner decides; amber only while the action still waits.
  if (run.status === 'needs_approval') return opts.approvalSettled ? 'idle' : 'needs-approval'
  if (run.status !== 'running') return 'idle'
  const calls = (run.tool_calls ?? []) as Partial<ToolCallEntry>[]
  return calls.some((c) => c?.status === 'running') ? 'acting' : 'thinking'
}
