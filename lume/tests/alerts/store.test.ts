import { beforeEach, describe, expect, it, vi } from 'vitest'

/** lib/alertsStore.ts against a recording fake of the service client. */

type Call = { table: string; op: string; args: unknown[] }
const calls: Call[] = []
let result: { data: unknown; error: unknown } = { data: [], error: null }

function client() {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'update', 'eq', 'is', 'in', 'order', 'limit']) {
        b[op] = (...args: unknown[]) => {
          calls.push({ table, op, args })
          return b
        }
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve(result)
      return b
    },
  }
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }))

import { ackAlerts, ALERTS_MAX_LIMIT, listAlerts } from '@/lib/alertsStore'

const op = (name: string) => calls.filter((c) => c.op === name)
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  calls.length = 0
  result = { data: [], error: null }
})

describe('listAlerts', () => {
  it('newest first, unacked only on request, limit clamped', async () => {
    result = { data: [{ id: A }], error: null }
    expect(await listAlerts({ unackedOnly: true, limit: 10 })).toEqual([{ id: A }])
    expect(calls[0].table).toBe('lume_alerts')
    expect(op('is')).toEqual([{ table: 'lume_alerts', op: 'is', args: ['acked_at', null] }])
    expect(op('order')[0].args).toEqual(['created_at', { ascending: false }])
    expect(op('limit')[0].args).toEqual([10])

    calls.length = 0
    await listAlerts({ unackedOnly: false, limit: 100000 })
    expect(op('is')).toEqual([])
    expect(op('limit')[0].args).toEqual([ALERTS_MAX_LIMIT])
  })

  it('a DB error throws', async () => {
    result = { data: null, error: { message: 'nope' } }
    await expect(listAlerts({ unackedOnly: true, limit: 5 })).rejects.toThrow('listAlerts')
  })
})

describe('ackAlerts', () => {
  it('ids: stamps only the still-unacked ones, records the operator, returns the acked ids', async () => {
    result = { data: [{ id: A }], error: null }
    const OP = '9b2f4c1e-0d3a-4e5b-8c7d-6e5f4a3b2c1d'
    expect(await ackAlerts({ ids: [A, B] }, OP)).toEqual([A])
    const [upd] = op('update')
    expect(upd.args[0]).toMatchObject({ acked_by_operator: OP })
    expect(typeof (upd.args[0] as { acked_at: string }).acked_at).toBe('string')
    expect(op('is')[0].args).toEqual(['acked_at', null])
    expect(op('in')[0].args).toEqual(['id', [A, B]])
  })

  it('all: no id filter; the owner leaves acked_by_operator null', async () => {
    result = { data: [{ id: A }, { id: B }], error: null }
    expect(await ackAlerts({ all: true }, null)).toEqual([A, B])
    expect(op('update')[0].args[0]).toMatchObject({ acked_by_operator: null })
    expect(op('in')).toEqual([])
  })

  it('an empty id list touches nothing', async () => {
    expect(await ackAlerts({ ids: [] }, null)).toEqual([])
    expect(calls).toEqual([])
  })
})
