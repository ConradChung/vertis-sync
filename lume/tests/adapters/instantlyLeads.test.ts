import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCampaignLeadCount, getContactUsage, getLeadsByIds, listCampaignLeads, timing } from '@/lib/adapters/instantlyLeads'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const NOW = new Date('2026-10-27T12:00:00Z')
const old = '2026-10-01T00:00:00Z'
const raw = (i: number, over: Record<string, unknown> = {}) => ({
  id: `l${i}`,
  email: `l${i}@x.com`,
  status: 3,
  timestamp_last_contact: old,
  email_reply_count: 0,
  campaign: 'c1',
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
const realSleep = timing.sleep

beforeEach(() => {
  process.env.INSTANTLY_API_KEY = 'test-key'
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  timing.sleep = vi.fn(async () => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_KEY
  timing.sleep = realSleep
})

describe('listCampaignLeads', () => {
  it('POSTs /leads/list with the mapped filter, pages with starting_after, applies client checks', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => raw(i))
    page1[3] = raw(3, { email_reply_count: 1 }) // replied: never "finished no reply"
    fetchMock.mockResolvedValueOnce(json({ items: page1, next_starting_after: 'l99' })).mockResolvedValueOnce(json({ items: [raw(100)] }))
    const r = await listCampaignLeads('c1', { state: 'finished_no_reply', days: 14 }, { limit: 5, now: NOW })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.instantly.ai/api/v2/leads/list')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer test-key')
    expect(JSON.parse(init.body)).toEqual({ campaign: 'c1', filter: 'FILTER_VAL_COMPLETED_NO_REPLY', limit: 100 })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).starting_after).toBe('l99')
    expect(r.leads).toHaveLength(5)
    expect(r.matched).toBe(100)
    expect(r.scanned).toBe(101)
    expect(r.truncated).toBe(false)
    expect(r.summary.by_status).toEqual({ completed: 100 })
  })

  it('stops at the page cap and says so', async () => {
    fetchMock.mockImplementation(async () => json({ items: Array.from({ length: 100 }, (_, i) => raw(i)), next_starting_after: 'x' }))
    const r = await listCampaignLeads('c1', { state: 'bounced' }, { maxPages: 2, now: NOW })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(r.truncated).toBe(true)
  })

  it('waits and retries on 429, then fails with InstantlyError after the retries', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429, { 'retry-after': '2' })).mockResolvedValueOnce(json({ items: [raw(1)] }))
    const r = await listCampaignLeads('c1', { state: 'replied' }, { now: NOW })
    expect(r.leads).toHaveLength(1)
    expect(timing.sleep).toHaveBeenCalledWith(2000)

    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => json({ message: 'slow down' }, 429))
    await expect(listCampaignLeads('c1', { state: 'replied' })).rejects.toMatchObject({ name: 'InstantlyError', status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws not configured without a key, without calling Instantly', async () => {
    delete process.env.INSTANTLY_API_KEY
    await expect(listCampaignLeads('c1', { state: 'replied' })).rejects.toThrow(/not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getLeadsByIds', () => {
  it('fetches by ids in chunks of 100 and keeps only requested ids of that campaign', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `l${i}`)
    fetchMock
      .mockResolvedValueOnce(json({ items: [raw(0), raw(1, { campaign: 'other' }), raw(999)] }))
      .mockResolvedValueOnce(json({ items: [raw(120)] }))
    const out = await getLeadsByIds('c1', ids)
    expect(out.map((f) => f.lead.id)).toEqual(['l0', 'l120'])
    expect(out[0].raw.email).toBe('l0@x.com')
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body1.ids).toHaveLength(100)
    expect(body1.campaign).toBe('c1')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).ids).toHaveLength(50)
  })
})

describe('getLeadsByIds: campaign must match exactly', () => {
  it('a lead with a missing or different campaign counts as not found', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [raw(1), raw(2, { campaign: undefined }), raw(3, { campaign: null }), raw(4, { campaign: 'other' })] })
    )
    const out = await getLeadsByIds('c1', ['l1', 'l2', 'l3', 'l4'])
    expect(out.map((f) => f.lead.id)).toEqual(['l1'])
  })
})

describe('getContactUsage / getCampaignLeadCount', () => {
  it('reads plan details', async () => {
    fetchMock.mockResolvedValueOnce(json({ subscriptions: { outreach: { current_lead_count: 10, total_lead_limit: 1000 } } }))
    expect(await getContactUsage()).toMatchObject({ current: 10, limit: 1000, headroom: 990 })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.instantly.ai/api/v2/workspace-billing/plan-details')
  })
  it('fails clearly when the plan has no outreach numbers', async () => {
    fetchMock.mockResolvedValueOnce(json({ subscriptions: {} }))
    await expect(getContactUsage()).rejects.toThrow(/no outreach/)
  })
  it('reads leads_count from campaign analytics', async () => {
    fetchMock.mockResolvedValueOnce(json([{ campaign_id: 'c1', leads_count: 812 }]))
    expect(await getCampaignLeadCount('c1')).toBe(812)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.instantly.ai/api/v2/campaigns/analytics?id=c1')
  })
})
