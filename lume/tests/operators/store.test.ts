import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** lib/operators/store.ts against a recording fake of the service client. */

type Call = { table: string; op: string; args: unknown[] }
const calls: Call[] = []
let result: { data: unknown; error: unknown } = { data: null, error: null }

function client() {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'insert', 'update', 'eq', 'is', 'order', 'limit', 'maybeSingle', 'single']) {
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
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }))

import {
  archiveVertical,
  createOperatorKey,
  createVertical,
  DuplicateVerticalNameError,
  findOperatorByKey,
  getOperator,
  getVertical,
  hashOperatorKey,
  listVerticals,
  revokeOperator,
  touchOperator,
  updateVertical,
} from '@/lib/operators/store'

const op = (name: string) => calls.filter((c) => c.op === name)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

beforeEach(() => {
  calls.length = 0
  result = { data: null, error: null }
})

describe('verticals', () => {
  it('lists live verticals by name, archived ones only on request', async () => {
    result = { data: [{ id: 'v1', name: 'A' }], error: null }
    expect(await listVerticals()).toEqual([{ id: 'v1', name: 'A' }])
    expect(op('is')[0].args).toEqual(['archived_at', null])
    expect(op('order')[0].args[0]).toBe('name')
    calls.length = 0
    await listVerticals({ includeArchived: true })
    expect(op('is')).toHaveLength(0)
  })

  it('creates with trimmed name, deduped scopes and campaign ids', async () => {
    result = { data: { id: 'v1' }, error: null }
    await createVertical({ name: '  Roofers ', scopes: ['campaign', 'campaign'], campaign_ids: ['c1', 'c1', ' c2 '] })
    expect(op('insert')[0].args[0]).toEqual({ name: 'Roofers', scopes: ['campaign'], campaign_ids: ['c1', 'c2'], is_default: false })
  })

  it('a duplicate name is a DuplicateVerticalNameError', async () => {
    result = { data: null, error: { code: '23505', message: 'dup' } }
    await expect(createVertical({ name: 'Roofers' })).rejects.toBeInstanceOf(DuplicateVerticalNameError)
  })

  it('other errors are DbErrors', async () => {
    result = { data: null, error: { code: '42501', message: 'nope' } }
    await expect(listVerticals()).rejects.toMatchObject({ name: 'DbError', op: 'listVerticals' })
  })

  it('updates only the given fields on a live vertical; null when missing', async () => {
    result = { data: [], error: null }
    expect(await updateVertical('v1', { scopes: ['orders'] })).toBeNull()
    expect(op('update')[0].args[0]).toEqual({ scopes: ['orders'] })
    expect(op('eq')[0].args).toEqual(['id', 'v1'])
    expect(op('is')[0].args).toEqual(['archived_at', null])
    result = { data: [{ id: 'v1', name: 'New' }], error: null }
    expect(await updateVertical('v1', { name: ' New ' })).toEqual({ id: 'v1', name: 'New' })
  })

  it('gets one vertical by id', async () => {
    result = { data: { id: 'v1', name: 'A' }, error: null }
    expect(await getVertical('v1')).toEqual({ id: 'v1', name: 'A' })
    expect(op('eq')[0].args).toEqual(['id', 'v1'])
  })

  it('archives once', async () => {
    result = { data: [{ id: 'v1' }], error: null }
    expect(await archiveVertical('v1')).toBe(true)
    expect(op('update')[0].args[0]).toHaveProperty('archived_at')
    result = { data: [], error: null }
    expect(await archiveVertical('v1')).toBe(false)
  })
})

describe('operator keys', () => {
  it('mints a 32-byte base64url key, stores only its sha256', async () => {
    result = { data: { id: 'o1', vertical_id: 'v1', is_master: false, label: 'bot' }, error: null }
    const { operator, rawKey } = await createOperatorKey({ verticalId: 'v1', label: ' bot ' })
    expect(rawKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(operator.id).toBe('o1')
    const row = op('insert')[0].args[0] as Record<string, unknown>
    expect(row).toEqual({ vertical_id: 'v1', is_master: false, label: 'bot', key_hash: sha(rawKey) })
    expect(JSON.stringify(calls)).not.toContain(rawKey)
    // select never returns the hash
    expect(String(op('select')[0].args[0])).not.toContain('key_hash')
  })

  it('a master key has no vertical', async () => {
    result = { data: { id: 'o2', is_master: true }, error: null }
    await createOperatorKey({ master: true, label: 'Master' })
    expect(op('insert')[0].args[0]).toMatchObject({ vertical_id: null, is_master: true })
  })

  it('keys differ every time', async () => {
    result = { data: { id: 'o1' }, error: null }
    const a = await createOperatorKey({ verticalId: 'v1', label: 'x' })
    const b = await createOperatorKey({ verticalId: 'v1', label: 'x' })
    expect(a.rawKey).not.toBe(b.rawKey)
  })

  it('hashOperatorKey is sha256 hex', () => {
    expect(hashOperatorKey('abc')).toBe(sha('abc'))
  })

  it('finds a live operator by its key', async () => {
    const raw = 'k'.repeat(43)
    result = { data: { id: 'o1', key_hash: sha(raw), revoked_at: null, label: 'bot' }, error: null }
    const found = await findOperatorByKey(raw)
    expect(found).toMatchObject({ id: 'o1', label: 'bot' })
    expect(found).not.toHaveProperty('key_hash')
    expect(op('eq')[0].args).toEqual(['key_hash', sha(raw)])
  })

  it('null for a revoked, unknown, mismatched or empty key', async () => {
    const raw = 'k'.repeat(43)
    result = { data: { id: 'o1', key_hash: sha(raw), revoked_at: '2026-10-26T00:00:00Z' }, error: null }
    expect(await findOperatorByKey(raw)).toBeNull()
    result = { data: null, error: null }
    expect(await findOperatorByKey(raw)).toBeNull()
    result = { data: { id: 'o1', key_hash: sha('other'), revoked_at: null }, error: null }
    expect(await findOperatorByKey(raw)).toBeNull()
    calls.length = 0
    expect(await findOperatorByKey('')).toBeNull()
    expect(await findOperatorByKey(null)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('getOperator / revokeOperator / touchOperator', async () => {
    result = { data: { id: 'o1' }, error: null }
    expect(await getOperator('o1')).toEqual({ id: 'o1' })
    calls.length = 0
    result = { data: [{ id: 'o1' }], error: null }
    expect(await revokeOperator('o1')).toBe(true)
    expect(op('update')[0].args[0]).toHaveProperty('revoked_at')
    expect(op('is')[0].args).toEqual(['revoked_at', null])
    calls.length = 0
    result = { data: null, error: null }
    await touchOperator('o1')
    expect(op('update')[0].args[0]).toHaveProperty('last_seen_at')
    expect(op('eq')[0].args).toEqual(['id', 'o1'])
  })
})
