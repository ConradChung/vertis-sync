import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ ok: true, via: 'session' })),
  requireOwnerSession: vi.fn(async () => ({ ok: true, via: 'session' })),
  set: vi.fn(async (n: number) => n),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner, requireOwnerSession: h.requireOwnerSession }))
vi.mock('@/lib/settings/store', () => ({ BANK_THRESHOLD_MAX: 100_000, getBankThreshold: async () => 1000, setBankThreshold: h.set }))

const { GET, PUT } = await import('@/app/api/settings/bank-threshold/route')
const put = (body: unknown) => PUT(new Request('http://x/api/settings/bank-threshold', { method: 'PUT', body: JSON.stringify(body) }))

describe('/api/settings/bank-threshold', () => {
  beforeEach(() => h.set.mockClear())
  it('GET returns the threshold and its max', async () => {
    expect(await (await GET(new Request('http://x'))).json()).toEqual({ threshold: 1000, max: 100_000 })
  })
  it('PUT saves a whole number (owner session only)', async () => {
    const res = await put({ threshold: 2500 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ threshold: 2500 })
    expect(h.set).toHaveBeenCalledWith(2500)
    expect(h.requireOwnerSession).toHaveBeenCalled()
  })
  it('PUT refuses 0, fractions, over the max and extra fields', async () => {
    for (const b of [{ threshold: 0 }, { threshold: 1.5 }, { threshold: 200_000 }, { threshold: 50, x: 1 }, {}]) expect((await put(b)).status).toBe(400)
    expect(h.set).not.toHaveBeenCalled()
  })
})
