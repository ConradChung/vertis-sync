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
  b.abortSignal = chain
  b.update = (row: unknown) => (writes.push({ table, op: 'update', row }), b)
  b.then = (r: (v: unknown) => unknown) => r({ data: [], error: null })
  return b
}
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (t: string) => builder(t),
    rpc: (fn: string, args: unknown) => (writes.push({ table: fn, op: 'rpc', row: args }), builder(fn)),
  }),
}))

import { insertMessage, createConversation } from '@/lib/agent/conversations'
import { insertAgentRun, updateAgentRun } from '@/lib/agent/runs'
import { logEvent } from '@/lib/db/service'
import { finishAction } from '@/lib/actions/store'
import { addMemory } from '@/lib/agent/memory'
import { insertPendingAction } from '@/lib/db/service'
import { createSkill } from '@/lib/agent/skills'
import { renameConversation } from '@/lib/agent/conversations'
import { alert } from '@/lib/alerts'

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

describe('no plaintext link: the review-found paths', () => {
  it('pending_actions payload, the alert feed (title/body/link), agent_skills, a conversation rename', async () => {
    await insertPendingAction({ kind: 'send_reply', payload: { body: `try ${RAW}`, summary: RAW }, requested_by: 'agent' }).catch(() => {})
    await alert({ source: 's', title: RAW, body: `b ${RAW}`, link: RAW })
    await createSkill({ name: `n ${RAW}`, description: RAW, steps: [{ type: 'note', text: RAW }] as never, variables: [], source_conversation_id: null }).catch(() => {})
    await renameConversation('c', `t ${RAW}`)
    const tables = writes.map((w) => w.table)
    expect(tables).toEqual(expect.arrayContaining(['pending_actions', 'lume_alert_upsert', 'agent_skills', 'agent_conversations']))
    expect(JSON.stringify(writes)).not.toContain('SECRETKEY987654')
  })

  it('alert() hands Telegram its own text, so callers mask before building it (see notify)', async () => {
    const telegram = vi.fn(async () => ({ ok: true }))
    await alert({ source: 's', title: 'x', telegram })
    expect(telegram).toHaveBeenCalled()
  })
})
