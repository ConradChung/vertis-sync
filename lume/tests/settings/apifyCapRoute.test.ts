import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ ok: true, via: 'session' })),
  requireOwnerSession: vi.fn(async () => ({ ok: true, via: 'session' })),
  set: vi.fn(async (n: number) => n),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner, requireOwnerSession: h.requireOwnerSession }))
vi.mock('@/lib/influencers/store', () => ({ apifyMonthSpend: async () => 12.5 }))
vi.mock('@/lib/settings/store', () => ({ APIFY_CAP_MAX_USD: 1000, getApifyCapUsd: async () => 29, setApifyCapUsd: h.set }))

const { GET, PUT } = await import('@/app/api/settings/apify-cap/route')
const put = (body: unknown) => PUT(new Request('http://x/api/settings/apify-cap', { method: 'PUT', body: JSON.stringify(body) }))

describe('/api/settings/apify-cap', () => {
  beforeEach(() => h.set.mockClear())
  it('GET returns the cap and month-to-date spend', async () => {
    expect(await (await GET(new Request('http://x'))).json()).toEqual({ cap_usd: 29, month_to_date_usd: 12.5, max_usd: 1000 })
  })
  it('PUT saves a valid cap (owner session only)', async () => {
    const res = await put({ cap_usd: 75 })
    expect(res.status).toBe(200)
    expect(h.set).toHaveBeenCalledWith(75)
    expect(h.requireOwnerSession).toHaveBeenCalled()
  })
  it('PUT refuses 0, negative, over the max and extra fields', async () => {
    for (const b of [{ cap_usd: 0 }, { cap_usd: -5 }, { cap_usd: 5000 }, { cap_usd: 50, x: 1 }, {}]) expect((await put(b)).status).toBe(400)
    expect(h.set).not.toHaveBeenCalled()
  })
})
