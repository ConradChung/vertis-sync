import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

/**
 * A request carrying a `lume_op` cookie for a revoked (or deleted) Grok Bot
 * operator is signed out locally in the middleware: Supabase signOut (local
 * scope), every sb-*-auth-token cookie and lume_op cleared, then /login for a
 * page or 401 for an API call. Live operators and the owner pass untouched.
 */

const h = vi.hoisted(() => ({ signOut: vi.fn(), user: { id: 'owner-id', email: 'owner@example.com' } as { id: string; email: string } | null }))
vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: async (request: NextRequest) => ({
    response: NextResponse.next({ request }),
    user: h.user,
    supabase: { auth: { signOut: h.signOut } },
  }),
}))

import { createHmac } from 'node:crypto'
import { middleware } from '@/middleware'
import { signOperatorCookie } from '@/lib/operators/cookie'
import { verifyOperatorCookieWeb } from '@/lib/operators/revocation'

const SECRET = 'internal-secret'
const OP = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const SB = 'sb-rcfrumrbauwvyzfebxck-auth-token'
const fetchMock = vi.fn()

const request = (path: string, cookie?: string) =>
  new NextRequest(`https://lume.test${path}`, { headers: cookie ? { cookie } : {} })
const signedIn = (opCookie?: string) =>
  [`${SB}.0=chunk0`, `${SB}.1=chunk1`, ...(opCookie ? [`lume_op=${opCookie}`] : [])].join('; ')
const rows = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** Every cookie this response sets to empty with Max-Age=0 (or an epoch expiry). */
function cleared(res: Response): string[] {
  const all = (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie()
  return all.filter((c) => /=;|=(?=;|$)/.test(c) && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(c)).map((c) => c.split('=')[0])
}

beforeEach(() => {
  vi.stubEnv('LUME_ALLOWED_EMAIL', 'owner@example.com')
  vi.stubEnv('LUME_INTERNAL_SECRET', SECRET)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.test')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
  vi.stubGlobal('fetch', fetchMock)
  h.signOut.mockResolvedValue({ error: null })
  h.user = { id: 'owner-id', email: 'owner@example.com' }
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  fetchMock.mockReset()
})

describe('middleware: revoked Grok Bot operator', () => {
  it('a page request with a revoked operator cookie signs out locally and redirects to /login', async () => {
    fetchMock.mockResolvedValue(rows([{ revoked_at: '2026-10-26T00:00:00Z' }]))
    const res = await middleware(request('/overview', signedIn(signOperatorCookie(OP, SECRET))))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(cleared(res)).toEqual(expect.arrayContaining(['lume_op', `${SB}.0`, `${SB}.1`]))
    // looked the operator up by id, with the service key
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://db.test/rest/v1/lume_operators?select=revoked_at&id=eq.${OP}`)
    expect(new Headers(init.headers).get('apikey')).toBe('service-key')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer service-key')
  })

  it('an API request with a revoked operator cookie is a 401, signed out', async () => {
    fetchMock.mockResolvedValue(rows([{ revoked_at: '2026-10-26T00:00:00Z' }]))
    const res = await middleware(request('/api/actions/x/decide', signedIn(signOperatorCookie(OP, SECRET))))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'operator_revoked' })
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(cleared(res)).toEqual(expect.arrayContaining(['lume_op', `${SB}.0`]))
  })

  it('a deleted operator (no row) is treated as revoked', async () => {
    fetchMock.mockResolvedValue(rows([]))
    const res = await middleware(request('/agent', signedIn(signOperatorCookie(OP, SECRET))))
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
  })

  it('a live operator passes through untouched', async () => {
    fetchMock.mockResolvedValue(rows([{ revoked_at: null }]))
    const res = await middleware(request('/operator', signedIn(signOperatorCookie(OP, SECRET))))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).toBe(200)
    expect(h.signOut).not.toHaveBeenCalled()
    expect(cleared(res)).toEqual([])
  })

  it('the owner (no lume_op cookie) passes without a DB lookup', async () => {
    const res = await middleware(request('/overview', signedIn()))
    expect(res.headers.get('location')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.signOut).not.toHaveBeenCalled()
  })

  it.each([
    ['forged (wrong secret)', () => signOperatorCookie(OP, 'forged')],
    ['stale (raw-secret key, pre key-derivation)', () => `${OP}.${createHmac('sha256', SECRET).update(OP).digest('base64url')}`],
    ['malformed', () => 'garbage'],
  ])('a present but unverifiable lume_op cookie (%s) signs out like a revoked one, without a DB lookup', async (_label, make) => {
    const page = await middleware(request('/overview', signedIn(make())))
    expect(new URL(page.headers.get('location')!).pathname).toBe('/login')
    expect(cleared(page)).toEqual(expect.arrayContaining(['lume_op', `${SB}.0`, `${SB}.1`]))
    const api = await middleware(request('/api/alerts', signedIn(make())))
    expect(api.status).toBe(401)
    expect(await api.json()).toEqual({ error: 'operator_revoked' })
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a lookup failure fails open (the owner is never locked out by a DB blip)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }))
    expect((await middleware(request('/overview', signedIn(signOperatorCookie(OP, SECRET))))).headers.get('location')).toBeNull()
    fetchMock.mockRejectedValue(new Error('network'))
    expect((await middleware(request('/overview', signedIn(signOperatorCookie(OP, SECRET))))).headers.get('location')).toBeNull()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('/auth/operator itself is not intercepted (a re-issued key can sign in over a stale cookie)', async () => {
    fetchMock.mockResolvedValue(rows([{ revoked_at: '2026-10-26T00:00:00Z' }]))
    const res = await middleware(request('/auth/operator?k=x', signedIn(signOperatorCookie(OP, SECRET))))
    expect(res.headers.get('location')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('verifyOperatorCookieWeb (Edge, Web Crypto)', () => {
  it('accepts exactly what the Node signer issues', async () => {
    const v = signOperatorCookie(OP, SECRET)
    expect(await verifyOperatorCookieWeb(v, SECRET)).toBe(OP)
    expect(await verifyOperatorCookieWeb(v, 'other')).toBeNull()
    const [id, mac] = v.split('.')
    expect(await verifyOperatorCookieWeb(`${id}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, SECRET)).toBeNull()
    for (const bad of [null, undefined, '', OP, `${OP}.`, `x.${mac}`]) expect(await verifyOperatorCookieWeb(bad, SECRET)).toBeNull()
    expect(await verifyOperatorCookieWeb(v, undefined)).toBeNull()
  })

  it('uses the same derived key as the Node signer: a raw-secret (legacy) cookie is rejected', async () => {
    const { createHmac } = await import('node:crypto')
    const legacy = `${OP}.${createHmac('sha256', SECRET).update(OP).digest('base64url')}`
    expect(await verifyOperatorCookieWeb(legacy, SECRET)).toBeNull()
    const derived = createHmac('sha256', SECRET).update('lume_op').digest()
    const current = `${OP}.${createHmac('sha256', derived).update(OP).digest('base64url')}`
    expect(await verifyOperatorCookieWeb(current, SECRET)).toBe(OP)
  })
})
