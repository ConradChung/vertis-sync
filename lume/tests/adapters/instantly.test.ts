import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearInstantlyCache,
  getAnalyticsOverview,
  getDailyAnalytics,
  isInstantlyConfigured,
  listAccounts,
  listCampaigns,
  mapLimit,
  retryAfterMs,
} from '@/lib/adapters/instantly'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  process.env.INSTANTLY_API_KEY = 'test-key'
  clearInstantlyCache()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_KEY
})

describe('instantly adapter (configured, mocked fetch)', () => {
  it('isInstantlyConfigured follows the env var', () => {
    expect(isInstantlyConfigured()).toBe(true)
    process.env.INSTANTLY_API_KEY = '  '
    expect(isInstantlyConfigured()).toBe(false)
  })

  it('pages the campaign list, drops deleted, sends the bearer', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, name: `C${String(i).padStart(3, '0')}`, status: i === 5 ? -1 : 1 }))
    fetchMock
      .mockResolvedValueOnce(json({ items: page1, next_starting_after: 'cur1' }))
      .mockResolvedValueOnce(json({ items: [{ id: 'last', name: 'ZZ', status: 2 }], next_starting_after: 'cur2' }))
    const out = await listCampaigns()
    expect(out).toHaveLength(100) // 101 minus the deleted one
    expect(out.find((c) => c.id === 'c5')).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url1, init1] = fetchMock.mock.calls[0]
    expect(url1).toBe('https://api.instantly.ai/api/v2/campaigns?limit=100')
    expect(init1.headers.Authorization).toBe('Bearer test-key')
    expect(fetchMock.mock.calls[1][0]).toContain('starting_after=cur1')
  })

  it('caches successful responses for 60 s per URL', async () => {
    fetchMock.mockImplementation(async () => json({ emails_sent_count: 10, reply_count: 1 }))
    await getAnalyticsOverview('abc')
    await getAnalyticsOverview('abc')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.instantly.ai/api/v2/campaigns/analytics/overview?id=abc')
    await getAnalyticsOverview()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('negative-caches a failure for 15 s, then retries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 })).mockResolvedValueOnce(json([{ date: '2026-10-15', sent: 3 }]))
      const q = { campaignId: 'x', startDate: '2026-10-09', endDate: '2026-10-15' }
      await expect(getDailyAnalytics(q)).rejects.toMatchObject({ status: 500 })
      await expect(getDailyAnalytics(q)).rejects.toMatchObject({ status: 500 }) // served from the negative cache
      expect(fetchMock).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 15_001)
      const out = await getDailyAnalytics(q)
      expect(out).toEqual([{ date: '2026-10-15', sent: 3, replies: 0, opportunities: 0 }])
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://api.instantly.ai/api/v2/campaigns/analytics/daily?campaign_id=x&start_date=2026-10-09&end_date=2026-10-15'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('a 429 is cached for its Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fetchMock
        .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '40' } }))
        .mockResolvedValueOnce(json({ emails_sent_count: 1 }))
      await expect(getAnalyticsOverview('r')).rejects.toMatchObject({ status: 429 })
      vi.setSystemTime(Date.now() + 20_000)
      await expect(getAnalyticsOverview('r')).rejects.toMatchObject({ status: 429 })
      vi.setSystemTime(Date.now() + 21_000)
      await expect(getAnalyticsOverview('r')).resolves.toMatchObject({ sent: 1 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one in-flight request per URL', async () => {
    let release!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
    const a = getAnalyticsOverview('same')
    const b = getAnalyticsOverview('same')
    await Promise.resolve()
    release(json({ emails_sent_count: 5, reply_count: 1 }))
    expect((await a).sent).toBe(5)
    expect((await b).sent).toBe(5)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retryAfterMs parses seconds and dates, floors at 15 s, caps at 5 min', () => {
    expect(retryAfterMs(null)).toBe(15_000)
    expect(retryAfterMs('3')).toBe(15_000)
    expect(retryAfterMs('40')).toBe(40_000)
    expect(retryAfterMs('99999')).toBe(300_000)
    expect(retryAfterMs(new Date(1_000_000 + 60_000).toUTCString(), 1_000_000)).toBe(60_000)
    expect(retryAfterMs('garbage')).toBe(15_000)
  })

  it('mapLimit keeps order and caps concurrency', async () => {
    let live = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 2))
      live--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90])
    expect(peak).toBe(4)
  })

  it('maps accounts to the five public fields', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [{ email: 'a@x.com', status: 1, warmup_status: 1, stat_warmup_score: 88, daily_limit: 40, refresh_token: 'x' }] })
    )
    expect(await listAccounts()).toEqual([
      { email: 'a@x.com', status: 'active', warmup_status: 'active', warmup_score: 88, daily_limit: 40 },
    ])
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.instantly.ai/api/v2/accounts?limit=100')
  })

  it('throws without calling fetch when unconfigured', async () => {
    delete process.env.INSTANTLY_API_KEY
    await expect(listAccounts()).rejects.toThrow(/not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
