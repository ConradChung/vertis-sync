import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearInstantlyCache,
  getAnalyticsOverview,
  getDailyAnalytics,
  isInstantlyConfigured,
  listAccounts,
  listCampaigns,
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

  it('does not cache failures and throws with the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 429 })).mockResolvedValueOnce(json([{ date: '2026-10-15', sent: 3 }]))
    await expect(getDailyAnalytics({ campaignId: 'x', startDate: '2026-10-09', endDate: '2026-10-15' })).rejects.toMatchObject({ status: 429 })
    const out = await getDailyAnalytics({ campaignId: 'x', startDate: '2026-10-09', endDate: '2026-10-15' })
    expect(out).toEqual([{ date: '2026-10-15', sent: 3, replies: 0, opportunities: 0 }])
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.instantly.ai/api/v2/campaigns/analytics/daily?campaign_id=x&start_date=2026-10-09&end_date=2026-10-15'
    )
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
