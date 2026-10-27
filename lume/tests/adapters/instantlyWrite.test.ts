import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteLeads } from '@/lib/adapters/instantlyWrite'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  process.env.INSTANTLY_API_KEY = 'test-key'
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_KEY
})

describe('deleteLeads', () => {
  it('DELETE /leads with campaign_id + ids, 100 per call, summing count', async () => {
    fetchMock.mockResolvedValueOnce(json({ count: 100 })).mockResolvedValueOnce(json({ count: 4 }))
    const ids = Array.from({ length: 105 }, (_, i) => `id${i}`)
    expect(await deleteLeads('c1', [...ids, 'id0'])).toBe(104)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.instantly.ai/api/v2/leads')
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body)).toEqual({ campaign_id: 'c1', ids: ids.slice(0, 100), limit: 100 })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ campaign_id: 'c1', ids: ids.slice(100), limit: 5 })
  })
  it('surfaces upstream failures as InstantlyError', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'nope' }, 400))
    await expect(deleteLeads('c1', ['a'])).rejects.toMatchObject({ name: 'InstantlyError', status: 400 })
  })
})
