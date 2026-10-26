import { beforeEach, describe, expect, it, vi } from 'vitest'

// No cookie session in these tests: the only way through is the internal bearer.
const getClaims = vi.fn(async (): Promise<{ data: { claims: Record<string, unknown> } | null; error: unknown }> => ({ data: null, error: null }))
const createClient = vi.fn(async () => ({ auth: { getClaims } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))

import { requireOwner } from '@/lib/auth/guards'
import { internalBearerMatches } from '@/lib/auth/internalBearer'

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
    createClient.mockClear()
    getClaims.mockClear()
  })

  it('passes when Authorization carries LUME_INTERNAL_SECRET, without touching the session', async () => {
    const auth = await requireOwner(req('Bearer internal-123'))
    expect(auth.ok).toBe(true)
    if (auth.ok) {
      expect(auth.via).toBe('internal')
      expect(auth.user).toBeNull()
    }
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects a present-but-wrong bearer with 401 immediately (no cookie fallback)', async () => {
    const auth = await requireOwner(req('Bearer nope'))
    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.response.status).toBe(401)
      expect(await auth.response.json()).toEqual({ error: 'unauthorized' })
    }
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects when the secret is unset even if a bearer is presented', async () => {
    delete process.env.LUME_INTERNAL_SECRET
    const auth = await requireOwner(req('Bearer internal-123'))
    expect(auth.ok).toBe(false)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('falls through to the cookie session with no bearer, and 401s without one', async () => {
    const auth = await requireOwner(req())
    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.response.status).toBe(401)
      expect(await auth.response.json()).toEqual({ error: 'unauthenticated' })
    }
    expect(createClient).toHaveBeenCalledTimes(1)
    const noReq = await requireOwner()
    expect(noReq.ok).toBe(false)
  })

  it('a non-bearer Authorization scheme is ignored and the session path is used', async () => {
    const auth = await requireOwner(req('Basic abc'))
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(401)
    expect(createClient).toHaveBeenCalledTimes(1)
  })
})

describe('requireOwner with a cookie session (claims verified locally)', () => {
  beforeEach(() => {
    process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
    getClaims.mockReset()
  })

  it('passes the owner, built from the verified JWT claims', async () => {
    getClaims.mockResolvedValueOnce({ data: { claims: { sub: 'u1', email: 'owner@example.com' } }, error: null })
    const auth = await requireOwner(req())
    expect(auth.ok).toBe(true)
    if (auth.ok) {
      expect(auth.via).toBe('session')
      expect(auth.user).toEqual({ id: 'u1', email: 'owner@example.com' })
    }
  })

  it('403s a verified session for another account', async () => {
    getClaims.mockResolvedValueOnce({ data: { claims: { sub: 'u2', email: 'someone@else.com' } }, error: null })
    const auth = await requireOwner(req())
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(403)
  })

  it('401s when claims fail verification, lack a subject, or getClaims throws', async () => {
    getClaims.mockResolvedValueOnce({ data: null, error: new Error('invalid JWT signature') })
    getClaims.mockResolvedValueOnce({ data: { claims: { email: 'owner@example.com' } }, error: null })
    getClaims.mockRejectedValueOnce(new Error('jwks fetch failed'))
    for (let i = 0; i < 3; i++) {
      const auth = await requireOwner(req())
      expect(auth.ok).toBe(false)
      if (!auth.ok) expect(auth.response.status).toBe(401)
    }
  })
})

describe('requireSecret', () => {
  beforeEach(() => {
    process.env.TEST_HOOK_SECRET = 'hook-abc'
  })

  it('reads a header by name', async () => {
    const { requireSecret } = await import('@/lib/auth/guards')
    const ok = requireSecret(new Request('http://x/api/hooks/a', { headers: { 'x-lume-secret': 'hook-abc' } }), 'x-lume-secret', 'TEST_HOOK_SECRET')
    expect(ok.ok).toBe(true)
    const bad = requireSecret(new Request('http://x/api/hooks/a', { headers: { 'x-lume-secret': 'nope' } }), 'x-lume-secret', 'TEST_HOOK_SECRET')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.response.status).toBe(401)
  })

  it('reads a query parameter with { query }', async () => {
    const { requireSecret } = await import('@/lib/auth/guards')
    expect(requireSecret(new Request('http://x/api/webhooks/i?secret=hook-abc'), { query: 'secret' }, 'TEST_HOOK_SECRET').ok).toBe(true)
    expect(requireSecret(new Request('http://x/api/webhooks/i?secret=wrong'), { query: 'secret' }, 'TEST_HOOK_SECRET').ok).toBe(false)
    expect(requireSecret(new Request('http://x/api/webhooks/i'), { query: 'secret' }, 'TEST_HOOK_SECRET').ok).toBe(false)
    // the header of the same name does not count for a query source
    expect(requireSecret(new Request('http://x/api/webhooks/i', { headers: { secret: 'hook-abc' } }), { query: 'secret' }, 'TEST_HOOK_SECRET').ok).toBe(false)
  })

  it('fails closed when the env var is unset', async () => {
    const { requireSecret } = await import('@/lib/auth/guards')
    delete process.env.TEST_HOOK_SECRET
    expect(requireSecret(new Request('http://x/?secret='), { query: 'secret' }, 'TEST_HOOK_SECRET').ok).toBe(false)
  })
})
