import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A chainable stand-in for the supabase query builder that records every call. */
const db = vi.hoisted(() => {
  const state = { calls: [] as { table: string; ops: [string, unknown[]][] }[], result: { data: [] as unknown, error: null as unknown } }
  const client = {
    from(table: string) {
      const entry = { table, ops: [] as [string, unknown[]][] }
      state.calls.push(entry)
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'update', 'eq', 'is', 'in', 'order', 'limit']) {
        q[m] = (...args: unknown[]) => {
          entry.ops.push([m, args])
          return q
        }
      }
      q.maybeSingle = () => Promise.resolve(state.result)
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(state.result).then(res, rej)
      return q
    },
  }
  return { state, client }
})
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))

import { claimPerson, decideSignalPerson, listReadyCommenters, listReadyReactors, releasePerson } from '@/lib/signal/store'

const ops = (i = 0) => db.state.calls[i].ops

beforeEach(() => {
  db.state.calls.length = 0
  db.state.result = { data: [], error: null }
})

describe('signal store queries', () => {
  it('the alerts query picks only ready commenters never alerted', async () => {
    await listReadyCommenters()
    expect(db.state.calls[0].table).toBe('signal_people')
    expect(ops()).toContainEqual(['eq', ['stage', 'ready']])
    expect(ops()).toContainEqual(['eq', ['kind', 'commenter']])
    expect(ops()).toContainEqual(['is', ['alert_status', null]])
  })

  it('reactors of a post: stage ready, kind reactor', async () => {
    await listReadyReactors('7400')
    expect(ops()).toContainEqual(['eq', ['post_id', '7400']])
    expect(ops()).toContainEqual(['eq', ['stage', 'ready']])
    expect(ops()).toContainEqual(['eq', ['kind', 'reactor']])
  })

  it('the claim is conditional on alert_status null and stage ready, and reports a lost race', async () => {
    db.state.result = { data: [], error: null }
    expect(await claimPerson(42, [])).toBe(false)
    expect(ops()[0][0]).toBe('update')
    expect((ops()[0][1][0] as Record<string, unknown>).alert_status).toBe('posted')
    expect(ops()).toContainEqual(['is', ['alert_status', null]])
    expect(ops()).toContainEqual(['eq', ['stage', 'ready']])
    db.state.result = { data: [{ id: 42 }], error: null }
    expect(await claimPerson(42, [])).toBe(true)
  })

  it('release only gives back an unposted claim', async () => {
    await releasePerson(42)
    expect((ops()[0][1][0] as Record<string, unknown>).alert_status).toBeNull()
    expect(ops()).toContainEqual(['eq', ['alert_status', 'posted']])
    expect(ops()).toContainEqual(['is', ['slack_ts', null]])
  })

  it('decisions are conditional on the open states', async () => {
    expect(await decideSignalPerson(42, ['posted', 'edited'], { alert_status: 'approved', decided_by: 'U0X' })).toBeNull()
    expect(ops()).toContainEqual(['in', ['alert_status', ['posted', 'edited']]])
  })
})
