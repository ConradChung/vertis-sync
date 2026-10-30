import type { OrbState } from '@/components/orb/Orb'

/** The slice of `agent_runs` the orb reads (RLS lets the owner's browser select it). */
export interface OrbRun {
  id: string
  status: 'running' | 'needs_approval' | 'done' | 'failed'
  tool_calls: unknown[] | null
  approval_action_id?: string | null
  created_at?: string | null
}

/**
 * A run still `running` after this long is dead (the route's maxDuration is
 * 300 s; the function was killed before it could record `failed`).
 */
export const STALE_RUN_MS = 6 * 60_000

/** `running` older than STALE_RUN_MS → treated as `failed`; anything else unchanged. */
export function withStaleRun<T extends OrbRun>(run: T | null, now: number = Date.now()): T | null {
  if (!run || run.status !== 'running' || !run.created_at) return run
  const started = Date.parse(run.created_at)
  if (!Number.isFinite(started) || now - started <= STALE_RUN_MS) return run
  return { ...run, status: 'failed' }
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
  /** Non-blocking notes on the call's result (e.g. SOP lint warnings), one per line. */
  warnings?: string[]
  action_id?: string
}

/**
 * Orb state from the latest run: listening (mic open) wins; then
 * needs_approval (action still awaiting) → amber; running with a tool in flight → acting;
 * running → thinking; anything else idle. A `running` row older than
 * STALE_RUN_MS counts as failed (idle), so a killed run never spins forever.
 */
export function orbStateFrom(
  run: OrbRun | null,
  opts: { listening?: boolean; approvalSettled?: boolean; now?: number } = {}
): OrbState {
  if (opts.listening) return 'listening'
  run = withStaleRun(run, opts.now)
  if (!run) return 'idle'
  // A run stays `needs_approval` after the owner decides; amber only while the action still waits.
  if (run.status === 'needs_approval') return opts.approvalSettled ? 'idle' : 'needs-approval'
  if (run.status !== 'running') return 'idle'
  const calls = (run.tool_calls ?? []) as Partial<ToolCallEntry>[]
  return calls.some((c) => c?.status === 'running') ? 'acting' : 'thinking'
}
