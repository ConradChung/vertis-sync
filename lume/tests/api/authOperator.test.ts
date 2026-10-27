import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  generateLink: vi.fn(),
  verifyOtp: vi.fn(),
  findOperatorByKey: vi.fn(),
  touchOperator: vi.fn(),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ auth: { admin: { generateLink: h.generateLink } } }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { verifyOtp: h.verifyOtp } }) }))
vi.mock('@/lib/operators/store', () => ({ findOperatorByKey: h.findOperatorByKey, touchOperator: h.touchOperator }))

import { GET } from '@/app/auth/operator/route'
import { verifyOperatorCookie } from '@/lib/operators/cookie'

const OP = { id: '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b', vertical_id: 'v1', is_master: false, label: 'Roofers bot', revoked_at: null }
const KEY = 'K'.repeat(43)
const req = (k?: string) => new Request(`https://lume.test/auth/operator${k === undefined ? '' : `?k=${encodeURIComponent(k)}`}`)

describe('/auth/operator', () => {
  beforeEach(() => {
    vi.stubEnv('LUME_ALLOWED_EMAIL', 'owner@example.com')
    vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
    h.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'th' } }, error: null })
    h.verifyOtp.mockResolvedValue({ error: null })
    h.touchOperator.mockResolvedValue(undefined)
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
})
