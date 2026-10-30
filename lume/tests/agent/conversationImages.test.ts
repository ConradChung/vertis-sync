import { beforeEach, describe, expect, it, vi } from 'vitest'

/** agent_messages keeps image references in `attachments` (never bytes) and reads them back. */
const calls: { table: string; op: string; arg: unknown }[] = []
function builder(table: string) {
  const b: Record<string, unknown> = {}
  const chain = () => b
  for (const m of ['eq', 'is', 'limit', 'order']) b[m] = chain
  b.select = (cols: unknown) => (calls.push({ table, op: 'select', arg: cols }), b)
  b.insert = (row: unknown) => (calls.push({ table, op: 'insert', arg: row }), b)
  b.update = (row: unknown) => (calls.push({ table, op: 'update', arg: row }), b)
  b.then = (r: (v: unknown) => unknown) => r({ data: [], error: null })
  return b
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => builder(t) }) }))

import { getMessages, insertMessage } from '@/lib/agent/conversations'

const IMG = { path: '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.png', name: 'shot.png', media_type: 'image/png' as const }

beforeEach(() => {
  calls.length = 0
})

describe('agent_messages attachments', () => {
  it('insertMessage stores the references', async () => {
    await insertMessage({ conversation_id: 'c', role: 'user', text: '', attachments: [IMG] })
    const row = calls.find((c) => c.op === 'insert')!.arg as Record<string, unknown>
    expect(row.attachments).toEqual([IMG])
  })
  it('defaults to none', async () => {
    await insertMessage({ conversation_id: 'c', role: 'user', text: 'hi' })
    expect((calls.find((c) => c.op === 'insert')!.arg as Record<string, unknown>).attachments).toEqual([])
  })
  it('getMessages reads the column back', async () => {
    await getMessages('c')
    expect(String(calls.find((c) => c.op === 'select')!.arg)).toContain('attachments')
  })
})
