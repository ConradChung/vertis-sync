import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { AgentRunRow, Json } from '@/lib/db/types'

/** `agent_runs` writes for the run route (service role, after `requireOwner`). */

export async function insertAgentRun(prompt: string, model: string): Promise<AgentRunRow> {
  const sb = createServiceClient()
  const res = await sb.from('agent_runs').insert({ prompt, model, status: 'running' }).select().single()
  if (res.error || !res.data) throw new DbError('insertAgentRun', res.error ?? new Error('no data'))
  return res.data as AgentRunRow
}

export type AgentRunPatch = Partial<
  Pick<AgentRunRow, 'status' | 'tool_calls' | 'approval_action_id' | 'outcome' | 'usage' | 'finished_at' | 'plan'>
>

export async function updateAgentRun(id: string, patch: AgentRunPatch): Promise<void> {
  const sb = createServiceClient()
  const res = await sb.from('agent_runs').update(patch as Record<string, Json>).eq('id', id)
  if (res.error) throw new DbError('updateAgentRun', res.error)
}
