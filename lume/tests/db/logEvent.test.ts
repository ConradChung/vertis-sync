import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A recording stand-in for the service client: every builder method logs its
 * call and returns the builder, and the awaited result is whatever the test
 * queued. Enough to assert the upsert/insert shape `logEvent` sends.
 */
type Call = [string, ...unknown[]]
const calls: Call[] = []
let result: { data: unknown; error: unknown } = { data: null, error: null }

function builder() {
  const b: Record<string, unknown> = {}
  for (const m of ['from', 'insert', 'upsert', 'select', 'single', 'maybeSingle']) {
    b[m] = (...args: unknown[]) => {
      calls.push([m, ...args])
      return b
    }
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve(result)
  return b
}

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => builder() }))

import { logEvent, DbError } from '@/lib/db/service'

const row = { id: 1, type: 'reply', source: 'instantly', title: 't', payload: {}, created_at: 'now' }

describe('logEvent', () => {
  beforeEach(() => {
    calls.length = 0
    result = { data: row, error: null }
  })

  it('upserts on webhook_id, ignoring duplicates, when webhook_id is set', async () => {
    const out = await logEvent({ type: 'reply', source: 'instantly', title: 't', webhook_id: 'wh_1', campaign_id: 'c1' })
    expect(out).toEqual(row)

    expect(calls[0]).toEqual(['from', 'events'])
    expect(calls[1][0]).toBe('upsert')
    expect(calls[1][1]).toMatchObject({ type: 'reply', source: 'instantly', title: 't', webhook_id: 'wh_1', campaign_id: 'c1', payload: {} })
    expect(calls[1][2]).toEqual({ onConflict: 'webhook_id', ignoreDuplicates: true })
    expect(calls.map((c) => c[0])).toEqual(['from', 'upsert', 'select', 'maybeSingle'])
    expect(calls.some((c) => c[0] === 'insert')).toBe(false)
  })

  it('returns null for an ignored duplicate (no row comes back)', async () => {
    result = { data: null, error: null }
    const out = await logEvent({ type: 'reply', source: 'instantly', title: 't', webhook_id: 'wh_1' })
    expect(out).toBeNull()
  })

  it('plain-inserts when webhook_id is absent', async () => {
    const out = await logEvent({ type: 'lume.decision', source: 'lume', title: 'approve', source_id: 'x' })
    expect(out).toEqual(row)
    expect(calls.map((c) => c[0])).toEqual(['from', 'insert', 'select', 'single'])
    expect(calls[1][1]).toMatchObject({ type: 'lume.decision', source: 'lume', source_id: 'x', webhook_id: null })
    expect(calls.some((c) => c[0] === 'upsert')).toBe(false)
  })

  it('throws DbError with the PostgREST code on failure', async () => {
    result = { data: null, error: { message: 'boom', code: '42P10', details: null, hint: null } }
    await expect(logEvent({ type: 'reply', source: 'instantly', title: 't', webhook_id: 'wh_1' })).rejects.toBeInstanceOf(DbError)
    await expect(logEvent({ type: 'reply', source: 'instantly', title: 't', webhook_id: 'wh_1' })).rejects.toMatchObject({ op: 'logEvent', code: '42P10' })
  })
})
