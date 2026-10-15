import { beforeEach, describe, expect, it, vi } from 'vitest'

// No cookie session in these tests: the only way through is the internal bearer.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}))

import { requireOwner } from '@/lib/auth/guards'
import { internalBearerMatches } from '@/lib/auth/internalBearer'
import { hasBearerToken } from '@/lib/auth/bearer'

describe('hasBearerToken (middleware shape check)', () => {
  it('is true for any non-empty bearer, regardless of validity', () => {
    expect(hasBearerToken('Bearer abc')).toBe(true)
    expect(hasBearerToken('bearer abc')).toBe(true)
    expect(hasBearerToken('  Bearer abc  ')).toBe(true)
  })

  it('is false for no header, other schemes and an empty token', () => {
    expect(hasBearerToken(null)).toBe(false)
    expect(hasBearerToken(undefined)).toBe(false)
    expect(hasBearerToken('')).toBe(false)
    expect(hasBearerToken('Bearer')).toBe(false)
    expect(hasBearerToken('Bearer ')).toBe(false)
    expect(hasBearerToken('Basic abc')).toBe(false)
    expect(hasBearerToken('abc')).toBe(false)
  })
})

const req = (authorization?: string) =>
  new Request('http://localhost/api/gates', { headers: authorization ? { authorization } : {} })

describe('internalBearerMatches', () => {
  it('accepts only "Bearer <secret>" for the configured secret', () => {
    expect(internalBearerMatches('Bearer top-secret', 'top-secret')).toBe(true)
    expect(internalBearerMatches('bearer top-secret', 'top-secret')).toBe(true)
    expect(internalBearerMatches('Bearer wrong', 'top-secret')).toBe(false)
    expect(internalBearerMatches('top-secret', 'top-secret')).toBe(false)
    expect(internalBearerMatches('Basic top-secret', 'top-secret')).toBe(false)
    expect(internalBearerMatches(null, 'top-secret')).toBe(false)
    expect(internalBearerMatches('Bearer ', '')).toBe(false)
    expect(internalBearerMatches('Bearer top-secret', undefined)).toBe(false)
  })
})

describe('requireOwner with the internal bearer', () => {
  beforeEach(() => {
    process.env.LUME_INTERNAL_SECRET = 'internal-123'
    process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  })

  it('passes when Authorization carries LUME_INTERNAL_SECRET', async () => {
    const auth = await requireOwner(req('Bearer internal-123'))
    expect(auth.ok).toBe(true)
    if (auth.ok) {
      expect(auth.via).toBe('internal')
      expect(auth.user).toBeNull()
    }
  })

  it('rejects a wrong bearer with 401 (falls back to the absent session)', async () => {
    const auth = await requireOwner(req('Bearer nope'))
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(401)
  })

  it('rejects when the secret is unset even if a bearer is presented', async () => {
    delete process.env.LUME_INTERNAL_SECRET
    const auth = await requireOwner(req('Bearer internal-123'))
    expect(auth.ok).toBe(false)
  })

  it('still 401s with no session and no header', async () => {
    const auth = await requireOwner(req())
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(401)
    const noReq = await requireOwner()
    expect(noReq.ok).toBe(false)
  })
})
