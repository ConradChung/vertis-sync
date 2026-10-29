import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emailsLimiter,
  EMAILS_PER_MINUTE,
  getEmail,
  getThreadEmails,
  listEmails,
  resetEmailsCache,
  RateLimitedError,
} from '@/lib/adapters/instantlyEmails'

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, thread_id: 't1', ue_type: 2, eaccount: 'f@ours.com', from_address_email: 'l@acme.com', subject: 'Re: x',
  body: { text: 'hi' }, timestamp_email: `2026-10-28T10:0${id.slice(-1)}:00.000Z`, campaign_id: 'c1', ...extra,
})

let fetchMock: ReturnType<typeof vi.fn>
let now = 1_000_000

beforeEach(() => {
  process.env.INSTANTLY_API_KEY = 'k'
  resetEmailsCache()
  now = 1_000_000
  emailsLimiter.now = () => now
  emailsLimiter.sleep = vi.fn(async (ms: number) => {
    now += ms
  })
  fetchMock = vi.fn(async () => Response.json({ items: [item('e1')] }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const urlOf = (i = 0) => new URL(String(fetchMock.mock.calls[i][0]))

describe('listEmails', () => {
  it('GET /emails with the filters, mapped', async () => {
    const out = await listEmails({ campaign_id: 'c1', email_type: 'received', is_unread: true, i_status: 1, limit: 25 })
    const u = urlOf()
    expect(u.pathname).toBe('/api/v2/emails')
    expect(Object.fromEntries(u.searchParams)).toEqual({ campaign_id: 'c1', email_type: 'received', is_unread: 'true', i_status: '1', limit: '25' })
    expect(out.emails[0]).toMatchObject({ id: 'e1', direction: 'in', campaign_id: 'c1' })
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k' })
  })

  it('a repeat within the TTL is served from cache (no upstream call)', async () => {
    await listEmails({ campaign_id: 'c1' })
    now += 30_000
    await listEmails({ campaign_id: 'c1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 31_000
    await listEmails({ campaign_id: 'c1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('the per-minute budget: past it, a cached answer is served stale, else RateLimitedError with retry_after', async () => {
    for (let i = 0; i < EMAILS_PER_MINUTE; i++) await listEmails({ campaign_id: `c${i}` })
    expect(fetchMock).toHaveBeenCalledTimes(EMAILS_PER_MINUTE)
    now += 50_000 // c0 is past its 45 s TTL but the 60 s window is still full
    const stale = await listEmails({ campaign_id: 'c0' })
    expect(stale.stale).toBe(true)
    await expect(listEmails({ campaign_id: 'never-seen' })).rejects.toBeInstanceOf(RateLimitedError)
    try {
      await listEmails({ campaign_id: 'never-seen' })
    } catch (e) {
      expect((e as RateLimitedError).retryAfterMs).toBeGreaterThan(0)
    }
    expect(fetchMock).toHaveBeenCalledTimes(EMAILS_PER_MINUTE)
  })

  it('an upstream 429 is remembered for Retry-After: no call until then', async () => {
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '20' } }))
    await expect(listEmails({ campaign_id: 'c1' })).rejects.toBeInstanceOf(RateLimitedError)
    await expect(listEmails({ campaign_id: 'c2' })).rejects.toBeInstanceOf(RateLimitedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 21_000
    await listEmails({ campaign_id: 'c2' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fresh reads bypass the cache and wait for a slot instead of failing', async () => {
    for (let i = 0; i < EMAILS_PER_MINUTE; i++) await listEmails({ campaign_id: `c${i}` })
    await getThreadEmails('t1', { fresh: true })
    expect(emailsLimiter.sleep).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(EMAILS_PER_MINUTE + 1)
    expect(urlOf(EMAILS_PER_MINUTE).searchParams.get('search')).toBe('thread:t1')
  })

  it('no key: InstantlyError, no call', async () => {
    delete process.env.INSTANTLY_API_KEY
    await expect(listEmails({})).rejects.toThrow(/not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getEmail / getThreadEmails', () => {
  it('GET /emails/{id}', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(item('e7')))
    expect((await getEmail('e7'))?.id).toBe('e7')
    expect(urlOf().pathname).toBe('/api/v2/emails/e7')
  })
  it('a 404 is null', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    expect(await getEmail('gone')).toBeNull()
  })
  it('thread: past the page cap with more to read → truncated', async () => {
    fetchMock.mockImplementation(async () => Response.json({ items: Array.from({ length: 100 }, (_, i) => item(`p${i}`)), next_starting_after: 'more' }))
    const out = await getThreadEmails('t1')
    expect(out.truncated).toBe(true)
    expect(out.emails).toHaveLength(500)
  })

  it('thread: every page of search=thread:<id>, ascending', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => item(`p${i}`))
    fetchMock.mockResolvedValueOnce(Response.json({ items: page1, next_starting_after: 'cur' }))
    fetchMock.mockResolvedValueOnce(Response.json({ items: [item('q1')] }))
    const out = await getThreadEmails('t1')
    expect(out.emails).toHaveLength(101)
    expect(out.truncated).toBe(false)
    expect(urlOf(0).searchParams.get('sort_order')).toBe('asc')
    expect(urlOf(1).searchParams.get('starting_after')).toBe('cur')
  })
})
