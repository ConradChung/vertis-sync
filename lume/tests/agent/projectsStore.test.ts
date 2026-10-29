import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A chainable stand-in for the service client: records each query's calls and answers from `answer`. */
const db = vi.hoisted(() => ({
  queries: [] as { table: string; calls: [string, unknown[]][] }[],
  answer: (_q: { table: string; calls: [string, unknown[]][] }): { data: unknown; error: unknown } => ({ data: [], error: null }),
}))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const q = { table, calls: [] as [string, unknown[]][] }
      db.queries.push(q)
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'insert', 'update', 'delete', 'maybeSingle', 'single']) {
        chain[m] = (...args: unknown[]) => {
          q.calls.push([m, args])
          return chain
        }
      }
      chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(db.answer(q)).then(ok, bad)
      return chain
    },
  }),
}))
vi.mock('@/lib/db/service', () => ({
  DbError: class DbError extends Error {
    constructor(where: string, readonly cause: { code?: string }) {
      super(where)
    }
  },
}))

import { addFile, addNote, itemsForBlock, moveConversation, ProjectGoneError } from '@/lib/agent/projects'

const PID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b01'
const meta = (id: string, chars: number, at: string) => ({ id, kind: 'file', name: id, mime: 'text/plain', size_bytes: chars, readable: true, truncated: false, text_chars: chars, created_at: at })

beforeEach(() => {
  db.queries = []
})

describe('itemsForBlock', () => {
  it('lists metadata (no text), then fetches text only for the ids chosen from text_chars', async () => {
    db.answer = (q) => {
      const cols = String(q.calls.find(([m]) => m === 'select')?.[1][0])
      if (!cols.includes('text_content'))
        return { data: [meta('new', 500, '2026-03-01'), meta('big', 190_000, '2026-02-01'), meta('old', 300, '2026-01-01')], error: null }
      return { data: [{ id: 'new', text_content: 'N' }, { id: 'old', text_content: 'O' }], error: null }
    }
    const items = await itemsForBlock(PID)
    expect(db.queries).toHaveLength(2)
    expect(String(db.queries[0].calls.find(([m]) => m === 'select')?.[1][0])).not.toContain('text_content')
    const inCall = db.queries[1].calls.find(([m]) => m === 'in')!
    expect(inCall[1]).toEqual(['id', ['new', 'old']])
    expect(db.queries[1].calls).toContainEqual(['eq', ['project_id', PID]])
    expect(items.map((i) => [i.id, i.text_content])).toEqual([['new', 'N'], ['big', null], ['old', 'O']])
  })

  it('no text query when nothing is small enough', async () => {
    db.answer = () => ({ data: [meta('big', 190_000, '2026-02-01')], error: null })
    await itemsForBlock(PID)
    expect(db.queries).toHaveLength(1)
  })
})

describe('the delete race', () => {
  it('a note, file or move into a project deleted meanwhile (fk violation) is ProjectGoneError', async () => {
    db.answer = () => ({ data: null, error: { code: '23503', message: 'violates foreign key constraint' } })
    await expect(addNote(PID, 'n', 'c')).rejects.toBeInstanceOf(ProjectGoneError)
    await expect(
      addFile({ project_id: PID, name: 'a', mime: 'text/plain', size_bytes: 1, storage_path: 'p', text_content: null, readable: false, truncated: false })
    ).rejects.toBeInstanceOf(ProjectGoneError)
    await expect(moveConversation('c1', PID)).rejects.toBeInstanceOf(ProjectGoneError)
  })
})
