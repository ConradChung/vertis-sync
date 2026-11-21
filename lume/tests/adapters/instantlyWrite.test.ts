import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as write from '@/lib/adapters/instantlyWrite'
import { timing } from '@/lib/adapters/instantlyLeads'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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

describe('deleteLead (DELETE /api/v2/leads/{id})', () => {
  it('deletes one lead by id, no body', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'L1' }))
    expect(await write.deleteLead('L1')).toBe('deleted')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.instantly.ai/api/v2/leads/L1')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
    expect(init.headers.Authorization).toBe('Bearer test-key')
  })
  it('404 → not_found (already gone)', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Lead not found' }, 404))
    expect(await write.deleteLead('L1')).toBe('not_found')
  })
  it('429 waits and retries', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({ id: 'L1' }))
    expect(await write.deleteLead('L1')).toBe('deleted')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('a 429 that outlasts the retries throws (status 429)', async () => {
    fetchMock.mockImplementation(async () => json({}, 429))
    await expect(write.deleteLead('L1')).rejects.toMatchObject({ name: 'InstantlyError', status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it.each([400, 401, 402, 500])('%i throws InstantlyError (checked, never treated as deleted)', async (status) => {
    fetchMock.mockResolvedValueOnce(json({ message: 'x' }, status))
    await expect(write.deleteLead('L1')).rejects.toMatchObject({ name: 'InstantlyError', status })
  })
  it('any other non-2xx throws InstantlyError', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'nope' }, 500))
    await expect(write.deleteLead('L1')).rejects.toMatchObject({ name: 'InstantlyError', status: 500 })
  })
  it('encodes the id', async () => {
    fetchMock.mockResolvedValueOnce(json({}))
    await write.deleteLead('a/b')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.instantly.ai/api/v2/leads/a%2Fb')
  })
  it('there is no bulk delete', () => {
    expect('deleteLeads' in write).toBe(false)
  })
})

describe('createCampaignFrom (duplicate): a draft, never started', () => {
  const src = { id: 'S1', name: 'Kaspen TX', status: 1, email_list: ['B@x.com', 'a@x.com'], campaign_schedule: { schedules: [{ name: 'w' }] }, daily_limit: 40, sequences: [{ steps: [] }], stop_on_reply: true }
  it('reads the source, POSTs /campaigns without any status, and never calls /activate', async () => {
    fetchMock.mockResolvedValueOnce(json(src)).mockResolvedValueOnce(json({ id: 'C9' }))
    const out = await write.createCampaignFrom('S1', 'Kaspen TX (copy)')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [getUrl, getInit] = fetchMock.mock.calls[0]
    expect(getUrl).toBe('https://api.instantly.ai/api/v2/campaigns/S1')
    expect(getInit.method).toBe('GET')
    const [postUrl, postInit] = fetchMock.mock.calls[1]
    expect(postUrl).toBe('https://api.instantly.ai/api/v2/campaigns')
    expect(postInit.method).toBe('POST')
    const body = JSON.parse(postInit.body)
    expect(body).not.toHaveProperty('status')
    expect(Object.keys(body).sort()).toEqual(['campaign_schedule', 'daily_limit', 'email_list', 'name', 'sequences', 'stop_on_reply'])
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/activate'))).toBe(false)
    expect(out).toEqual({ id: 'C9', name: 'Kaspen TX (copy)', sourceHash: write.sourceHash(src) })
  })
})

describe('sourceHash', () => {
  const base = { email_list: ['a@x.com', 'B@x.com'], campaign_schedule: { a: 1, b: { c: 2 } }, daily_limit: 40, sequences: [{ steps: [{ x: 1 }] }], stop_on_reply: true }
  it('ignores name, status and inbox order/case, and key order', () => {
    expect(write.sourceHash({ ...base, name: 'X', status: 2 })).toBe(write.sourceHash({ ...base, email_list: ['b@x.com', 'A@X.com'], campaign_schedule: { b: { c: 2 }, a: 1 } }))
    expect(write.sourceHash(base)).toMatch(/^[0-9a-f]{32}$/)
  })
  it.each([
    ['inboxes', { email_list: ['a@x.com'] }],
    ['schedule', { campaign_schedule: { a: 2 } }],
    ['daily limit', { daily_limit: 41 }],
    ['sequence', { sequences: [{ steps: [{ x: 2 }] }] }],
    ['stop on reply', { stop_on_reply: false }],
  ])('changes when the %s change', (_label, over) => {
    expect(write.sourceHash({ ...base, ...over })).not.toBe(write.sourceHash(base))
  })
})

describe('createCampaignFrom refuses a changed source', () => {
  const src = { id: 'S1', email_list: ['a@x.com'], daily_limit: 40, sequences: [], stop_on_reply: true }
  it('throws SourceChangedError and never POSTs when the fingerprint differs', async () => {
    fetchMock.mockResolvedValueOnce(json(src))
    await expect(write.createCampaignFrom('S1', 'Copy', undefined, { expectSourceHash: 'f'.repeat(32) })).rejects.toBeInstanceOf(write.SourceChangedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })
  it('creates when the fingerprint matches', async () => {
    fetchMock.mockResolvedValueOnce(json(src)).mockResolvedValueOnce(json({ id: 'C2' }))
    expect((await write.createCampaignFrom('S1', 'Copy', undefined, { expectSourceHash: write.sourceHash(src) })).id).toBe('C2')
  })
})
