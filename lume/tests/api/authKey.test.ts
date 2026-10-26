import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  generateLink: vi.fn(),
  verifyOtp: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ auth: { admin: { generateLink: h.generateLink } } }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { verifyOtp: h.verifyOtp } }) }))

import { GET } from '@/app/auth/key/route'

const req = (k?: string) => new Request(`https://lume.test/auth/key${k === undefined ? '' : `?k=${encodeURIComponent(k)}`}`)

describe('/auth/key', () => {
  beforeEach(() => {
    vi.stubEnv('LUME_OWNER_KEY', 'k'.repeat(43))
    vi.stubEnv('LUME_ALLOWED_EMAIL', 'owner@example.com')
    h.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'th' } }, error: null })
    h.verifyOtp.mockResolvedValue({ error: null })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('404s when no key is configured', async () => {
    vi.stubEnv('LUME_OWNER_KEY', '')
    expect((await GET(req('x'))).status).toBe(404)
    expect(h.generateLink).not.toHaveBeenCalled()
  })

  it('rejects a wrong or missing key without minting a token', async () => {
    for (const k of [undefined, 'wrong']) {
      const res = await GET(req(k))
      expect(res.headers.get('location')).toContain('/login?error=')
    }
    expect(h.generateLink).not.toHaveBeenCalled()
  })

  it('signs the owner in with the right key', async () => {
    const res = await GET(req('k'.repeat(43)))
    expect(h.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'owner@example.com' })
    expect(h.verifyOtp).toHaveBeenCalledWith({ token_hash: 'th', type: 'magiclink' })
    expect(res.headers.get('location')).toMatch(/\/overview$/)
  })
})
