import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  generateLink: vi.fn(),
  verifyOtp: vi.fn(),
  findOperatorByKey: vi.fn(),
  touchOperator: vi.fn(),
  recordOperatorSession: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ auth: { admin: { generateLink: h.generateLink } } }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { verifyOtp: h.verifyOtp, signOut: h.signOut } }) }))
vi.mock('@/lib/operators/store', () => ({
  findOperatorByKey: h.findOperatorByKey,
  touchOperator: h.touchOperator,
  recordOperatorSession: h.recordOperatorSession,
}))

import { GET } from '@/app/auth/operator/route'
import { verifyOperatorCookie } from '@/lib/operators/cookie'

const OP = { id: '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b', vertical_id: 'v1', is_master: false, label: 'Roofers bot', revoked_at: null }
const KEY = 'K'.repeat(43)
const SESSION_ID = '5f0c2a1b-3d4e-4f5a-8b6c-7d8e9f0a1b2c'
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: object) => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`
const minted = (claims: object = { sub: 'owner-id', session_id: SESSION_ID }) => ({ data: { session: { access_token: jwt(claims) } }, error: null })
const req = (k?: string) => new Request(`https://lume.test/auth/operator${k === undefined ? '' : `?k=${encodeURIComponent(k)}`}`)

describe('/auth/operator', () => {
  beforeEach(() => {
    vi.stubEnv('LUME_ALLOWED_EMAIL', 'owner@example.com')
    vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
    h.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'th' } }, error: null })
    h.verifyOtp.mockResolvedValue(minted())
    h.touchOperator.mockResolvedValue(undefined)
    h.recordOperatorSession.mockResolvedValue(undefined)
    h.signOut.mockResolvedValue({ error: null })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('a live key: owner session + signed lume_op cookie, touched, → /operator, no referrer', async () => {
    h.findOperatorByKey.mockResolvedValue(OP)
    const res = await GET(req(KEY))
    expect(h.findOperatorByKey).toHaveBeenCalledWith(KEY)
    expect(h.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'owner@example.com' })
    expect(h.verifyOtp).toHaveBeenCalledWith({ token_hash: 'th', type: 'magiclink' })
    expect(h.touchOperator).toHaveBeenCalledWith(OP.id)
    // The minted session is recorded so revoking the key can sign this bot out.
    expect(h.recordOperatorSession).toHaveBeenCalledWith(OP.id, SESSION_ID)
    expect(h.signOut).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toMatch(/\/operator$/)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const cookie = res.cookies.get('lume_op')
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    expect(verifyOperatorCookie(cookie!.value, 'internal-secret')).toBe(OP.id)
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/HttpOnly/i)
    expect(header).toMatch(/Secure/i)
    expect(header).toMatch(/SameSite=lax/i)
  })

  it('an invalid or revoked key (lookup null) or no key → /login?error=exchange_failed, nothing minted', async () => {
    h.findOperatorByKey.mockResolvedValue(null)
    for (const k of [undefined, 'wrong', KEY]) {
      const res = await GET(req(k))
      expect(res.headers.get('location')).toMatch(/\/login\?error=exchange_failed$/)
      expect(res.cookies.get('lume_op')).toBeUndefined()
    }
    expect(h.generateLink).not.toHaveBeenCalled()
    expect(h.touchOperator).not.toHaveBeenCalled()
  })

  it('fails closed without LUME_INTERNAL_SECRET or the owner email', async () => {
    h.findOperatorByKey.mockResolvedValue(OP)
    vi.stubEnv('LUME_INTERNAL_SECRET', '')
    expect((await GET(req(KEY))).headers.get('location')).toContain('/login?error=exchange_failed')
    vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
    vi.stubEnv('LUME_ALLOWED_EMAIL', '')
    expect((await GET(req(KEY))).headers.get('location')).toContain('/login?error=exchange_failed')
    expect(h.generateLink).not.toHaveBeenCalled()
  })

  it('a failed session mint or a lookup error → exchange_failed, no cookie', async () => {
    h.findOperatorByKey.mockResolvedValue(OP)
    h.verifyOtp.mockResolvedValue({ error: { message: 'expired' } })
    const res = await GET(req(KEY))
    expect(res.headers.get('location')).toContain('/login?error=exchange_failed')
    expect(res.cookies.get('lume_op')).toBeUndefined()
    h.findOperatorByKey.mockRejectedValue(new Error('db down'))
    expect((await GET(req(KEY))).headers.get('location')).toContain('/login?error=exchange_failed')
  })

  it('fails closed when the session cannot be recorded: signs the fresh session out, no cookie', async () => {
    h.findOperatorByKey.mockResolvedValue(OP)
    h.recordOperatorSession.mockRejectedValue(new Error('db down'))
    const res = await GET(req(KEY))
    expect(res.headers.get('location')).toContain('/login?error=exchange_failed')
    expect(res.cookies.get('lume_op')).toBeUndefined()
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('fails closed when the minted session carries no session_id', async () => {
    h.findOperatorByKey.mockResolvedValue(OP)
    for (const v of [{ data: { session: null }, error: null }, minted({ sub: 'owner-id' }), minted({ sub: 'x', session_id: 'not-a-uuid' })]) {
      h.verifyOtp.mockResolvedValueOnce(v)
      const res = await GET(req(KEY))
      expect(res.headers.get('location')).toContain('/login?error=exchange_failed')
      expect(res.cookies.get('lume_op')).toBeUndefined()
    }
    expect(h.recordOperatorSession).not.toHaveBeenCalled()
    expect(h.signOut).toHaveBeenCalledTimes(3)
  })
})
