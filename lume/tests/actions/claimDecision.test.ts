import { beforeEach, describe, expect, it, vi } from 'vitest'

/** claimDecision records who decided: the owner in Lume, or the agent in skip mode. */
const updates: Record<string, unknown>[] = []

function client() {
  return {
    from: () => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.update = (patch: Record<string, unknown>) => {
        updates.push(patch)
        return b
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: 'a1' }], error: null })
      return b
    },
  }
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }))

import { claimDecision } from '@/lib/actions/store'

beforeEach(() => {
  updates.length = 0
})

describe('claimDecision', () => {
  it("defaults to decided_via 'lume'", async () => {
    await claimDecision('a1', true)
    expect(updates[0]).toMatchObject({ decided_via: 'lume', status: 'approved' })
  })
  it("records decided_via 'agent' in skip mode", async () => {
    const row = await claimDecision('a1', true, 'agent')
    expect(updates[0]).toMatchObject({ decided_via: 'agent', status: 'approved' })
    expect(row).toEqual({ id: 'a1' })
  })
})
