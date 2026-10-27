import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every write Lume makes that could carry an agent-shown sign-in link goes through the mask.
const writes: { table: string; op: string; row: unknown }[] = []
function builder(table: string) {
  const b: Record<string, unknown> = {}
  const chain = () => b
  for (const m of ['select', 'eq', 'is', 'ilike', 'limit', 'order', 'in']) b[m] = chain
  b.maybeSingle = async () => ({ data: null, error: null })
  b.single = async () => ({ data: { id: 'x' }, error: null })
  b.insert = (row: unknown) => (writes.push({ table, op: 'insert', row }), b)
  b.update = (row: unknown) => (writes.push({ table, op: 'update', row }), b)
  b.then = (r: (v: unknown) => unknown) => r({ data: [], error: null })
  return b
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => builder(t) }) }))

import { insertMessage, createConversation } from '@/lib/agent/conversations'
import { insertAgentRun, updateAgentRun } from '@/lib/agent/runs'
import { logEvent } from '@/lib/db/service'
import { finishAction } from '@/lib/actions/store'
import { addMemory } from '@/lib/agent/memory'

const RAW = 'https://lume.test/auth/operator?k=SECRETKEY987654'
beforeEach(() => {
  writes.length = 0
})

describe('no plaintext operator sign-in link is persisted', () => {
  it('agent_messages, agent_conversations, agent_runs, events, pending_actions.result, agent_memory', async () => {
    await insertMessage({ conversation_id: 'c', role: 'assistant', text: `Here: ${RAW}`, tools: [{ id: 't', name: 'x', tier: 'high', status: 'ok', error: RAW }] as never, error: RAW })
    await createConversation(`Give ${RAW}`)
    await insertAgentRun(`prompt ${RAW}`, 'm')
    await updateAgentRun('r', { outcome: `done ${RAW}`, tool_calls: [{ error: RAW }] as never })
    await logEvent({ type: 't', source: 's', title: RAW, payload: { result: { sign_in_url: RAW } } })
    await finishAction('a', 'executed', { note: RAW }, RAW)
    await addMemory('fact' as never, `link ${RAW}`, null).catch(() => {})
    const all = JSON.stringify(writes)
    expect(writes.length).toBeGreaterThanOrEqual(7)
    expect(all).not.toContain('SECRETKEY987654')
    expect(all).toContain('k=SECR****')
  })
})
