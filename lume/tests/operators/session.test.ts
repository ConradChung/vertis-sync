import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getOperator: vi.fn() }))
vi.mock('@/lib/operators/store', () => ({ getOperator: h.getOperator }))

import { signOperatorCookie } from '@/lib/operators/cookie'
import { currentOperator } from '@/lib/operators/session'

const ID = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const SECRET = 'internal-secret'
const live = { id: ID, vertical_id: 'v1', is_master: false, label: 'Roofers bot', created_at: '', revoked_at: null, last_seen_at: null }

const reqWith = (cookie?: string) => new Request('https://lume.test/x', { headers: cookie ? { cookie } : {} })
const store = (value?: string) => {
  const del = vi.fn()
  return { del, src: { get: (n: string) => (n === 'lume_op' && value ? { value } : undefined), delete: del } }
}

beforeEach(() => vi.stubEnv('LUME_INTERNAL_SECRET', SECRET))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('currentOperator', () => {
  it('loads the operator a valid cookie names (Request or cookie store)', async () => {
    h.getOperator.mockResolvedValue(live)
    expect(await currentOperator(reqWith(`a=1; lume_op=${signOperatorCookie(ID, SECRET)}`))).toEqual(live)
    expect(await currentOperator(store(signOperatorCookie(ID, SECRET)).src)).toEqual(live)
    expect(h.getOperator).toHaveBeenCalledWith(ID)
  })

  it('null without a cookie, or with a bad HMAC, before touching the DB', async () => {
    expect(await currentOperator(reqWith())).toBeNull()
    expect(await currentOperator(reqWith(`lume_op=${signOperatorCookie(ID, 'forged')}`))).toBeNull()
    expect(await currentOperator(store().src)).toBeNull()
    expect(h.getOperator).not.toHaveBeenCalled()
  })

  it('null for a revoked or deleted operator, clearing the cookie where it can', async () => {
    h.getOperator.mockResolvedValue({ ...live, revoked_at: '2026-10-26T00:00:00Z' })
    const s = store(signOperatorCookie(ID, SECRET))
    expect(await currentOperator(s.src)).toBeNull()
    expect(s.del).toHaveBeenCalledWith('lume_op')
    h.getOperator.mockResolvedValue(null)
    expect(await currentOperator(reqWith(`lume_op=${signOperatorCookie(ID, SECRET)}`))).toBeNull()
  })

  it('a read-only cookie store (server component) does not throw', async () => {
    h.getOperator.mockResolvedValue({ ...live, revoked_at: 'x' })
    const src = { get: () => ({ value: signOperatorCookie(ID, SECRET) }), delete: () => { throw new Error('read-only') } }
    expect(await currentOperator(src)).toBeNull()
  })

  it('a DB error is "not an operator"', async () => {
    h.getOperator.mockRejectedValue(new Error('db down'))
    expect(await currentOperator(reqWith(`lume_op=${signOperatorCookie(ID, SECRET)}`))).toBeNull()
  })
})
