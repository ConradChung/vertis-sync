import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `.in()` lookups chunk at 100 ids (a 5k selection in one GET overflows the
 * URL), and the interrupted-action recovery's filters. Fake query builder:
 * every `from()` chain records its calls; awaiting it resolves the next
 * queued result.
 */
type Call = [string, ...unknown[]]
const chains: Call[][] = []
const results: { data: unknown; error: unknown }[] = []

function client() {
  return {
    from: (table: string) => {
      const calls: Call[] = [['from', table]]
      chains.push(calls)
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'update', 'eq', 'is', 'lt', 'in', 'limit', 'order', 'not']) {
        b[m] = (...args: unknown[]) => {
          calls.push([m, ...args])
          return b
        }
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve(results.shift() ?? { data: [], error: null })
      return b
    },
  }
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }))

import { failInterruptedActions, IN_CHUNK, resolveLeadsByRefs } from '@/lib/actions/store'
import { resolveLeadRefs } from '@/lib/db/service'

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const inArgs = () => chains.map((c) => c.find((x) => x[0] === 'in')).filter(Boolean) as Call[]

beforeEach(() => {
  chains.length = 0
  results.length = 0
})

describe('resolveLeadsByRefs (store)', () => {
  it('looks 250 ids up in chunks of 100 and merges the results', async () => {
    expect(IN_CHUNK).toBe(100)
    const refs = Array.from({ length: 250 }, (_, i) => ({ origin: 'lead_bank' as const, id: uuid(i) }))
    results.push(
      { data: [{ origin: 'lead_bank', id: uuid(1), email: 'a@x.com', campaign_id: null }], error: null },
      { data: [{ origin: 'lead_bank', id: uuid(150), email: 'b@x.com', campaign_id: null }], error: null },
      { data: [{ origin: 'lead_bank', id: uuid(249), email: 'c@x.com', campaign_id: 'camp' }], error: null }
    )
    const out = await resolveLeadsByRefs(refs, 'camp')
    const ins = inArgs()
    expect(ins.map((c) => (c[2] as string[]).length)).toEqual([100, 100, 50])
    expect(ins.every((c) => c[1] === 'id')).toBe(true)
    expect(out.map((r) => r.email)).toEqual(['a@x.com', 'b@x.com']) // the one already in camp is skipped
  })
})

describe('resolveLeadRefs (service)', () => {
  it('chunks at 100, dedupes ids, keeps ref order and drops leads already in the campaign', async () => {
    const refs = Array.from({ length: 205 }, (_, i) => ({ origin: 'validation_rows' as const, id: uuid(i) }))
    refs.push({ origin: 'validation_rows', id: uuid(0) }) // duplicate
    results.push(
      { data: [{ origin: 'validation_rows', id: uuid(3), campaign_id: null }], error: null },
      { data: [{ origin: 'validation_rows', id: uuid(120), campaign_id: 'camp' }], error: null },
      { data: [{ origin: 'validation_rows', id: uuid(204), campaign_id: 'other' }], error: null }
    )
    const out = await resolveLeadRefs(refs, 'camp')
    expect(inArgs().map((c) => (c[2] as string[]).length)).toEqual([100, 100, 5])
    expect(out).toEqual([
      { origin: 'validation_rows', id: uuid(3) },
      { origin: 'validation_rows', id: uuid(204) },
    ])
  })

  it('a failed chunk throws', async () => {
    results.push({ data: null, error: { message: 'boom', code: 'XX000' } })
    await expect(resolveLeadRefs([{ origin: 'lead_bank', id: uuid(1) }], 'camp')).rejects.toThrow()
  })
})

describe('failInterruptedActions', () => {
  it('only executing rows never finished and untouched since the cutoff become failed/interrupted', async () => {
    results.push({ data: [{ id: 'a1' }], error: null }, { data: [{ id: 'a1', kind: 'pause_campaign', status: 'failed' }], error: null })
    const cutoff = new Date('2026-10-25T11:50:00Z')
    const rows = await failInterruptedActions(cutoff)
    expect(rows).toHaveLength(1)
    const [sel, upd] = chains
    const has = (calls: Call[], ...c: unknown[]) => calls.some((x) => JSON.stringify(x) === JSON.stringify(c))
    expect(has(sel, 'eq', 'status', 'executing')).toBe(true)
    expect(has(sel, 'is', 'executed_at', null)).toBe(true)
    expect(has(sel, 'lt', 'updated_at', cutoff.toISOString())).toBe(true)
    const update = upd.find((c) => c[0] === 'update')![1] as Record<string, unknown>
    expect(update).toMatchObject({ status: 'failed', error: 'interrupted', result: { error: 'interrupted' } })
    expect(has(upd, 'in', 'id', ['a1'])).toBe(true)
    expect(has(upd, 'eq', 'status', 'executing')).toBe(true) // a late finishAction wins the race
    expect(has(upd, 'is', 'executed_at', null)).toBe(true)
  })

  it('nothing stale → no update', async () => {
    results.push({ data: [], error: null })
    expect(await failInterruptedActions(new Date())).toEqual([])
    expect(chains).toHaveLength(1)
  })
})
