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
