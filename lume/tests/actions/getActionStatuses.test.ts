import { describe, expect, it, vi } from 'vitest'

/** getActionStatuses reads many rows' status in one `in` query. */
const calls: { select?: string; in?: [string, unknown] }[] = []

function client() {
  return {
    from: (table: string) => {
      expect(table).toBe('pending_actions')
      const call: (typeof calls)[number] = {}
      calls.push(call)
      const b: Record<string, unknown> = {}
      b.select = (cols: string) => {
        call.select = cols
        return b
      }
      b.in = (col: string, v: unknown) => {
        call.in = [col, v]
        return b
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: 'a1', status: 'executed' }], error: null })
      return b
    },
  }
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }))

import { getActionStatuses } from '@/lib/actions/store'

describe('getActionStatuses', () => {
  it('one in-query, keyed by id', async () => {
    const m = await getActionStatuses(['a1', 'a2', 'a1'])
    expect(calls).toEqual([{ select: 'id,status', in: ['id', ['a1', 'a2']] }])
    expect(m).toEqual(new Map([['a1', 'executed']]))
  })
  it('no ids → no query', async () => {
    calls.length = 0
    expect(await getActionStatuses([])).toEqual(new Map())
    expect(calls).toEqual([])
  })
})
