import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { classifyDomains, CRAWL_BATCH_MAX } from '@/lib/crawl/worker'

const fetchMock = vi.fn()
const row = (domain: string, verdict = 'property_manager') => ({
  domain, verdict, confidence: 'high', reason: 'r', linkedin_url: null, doors_hint: '200 doors', property_type: 'multifamily', pages: ['/'],
})
const okBody = (domains: string[]) => new Response(JSON.stringify({ ok: true, results: domains.map((d) => row(d)) }))

beforeEach(() => {
  process.env.CRAWL_WORKER_URL = 'https://crawl.example.app/'
  process.env.CRAWL_WORKER_SECRET = 'worker_test_secret'
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('crawl worker client', () => {
  it('is not_configured without env and never calls fetch', async () => {
    delete process.env.CRAWL_WORKER_URL
    expect(await classifyDomains(['a.com'])).toEqual({ ok: false, error: 'not_configured', results: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the secret as a header, never in the URL or body', async () => {
    fetchMock.mockResolvedValue(okBody(['a.com']))
    const out = await classifyDomains(['a.com'])
    expect(out.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://crawl.example.app/classify')
    expect(init.headers['X-Worker-Secret']).toBe('worker_test_secret')
    expect(String(url) + init.body).not.toContain('worker_test_secret')
    expect(JSON.parse(init.body)).toEqual({ domains: ['a.com'] })
  })

  it('passes custom rules through', async () => {
    fetchMock.mockResolvedValue(okBody(['a.com']))
    await classifyDomains(['a.com'], 'HOA managers only')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).rules).toBe('HOA managers only')
  })

  it('splits into batches of 50 and concatenates in order', async () => {
    const domains = Array.from({ length: CRAWL_BATCH_MAX + 3 }, (_, i) => `d${i}.com`)
    fetchMock.mockImplementation(async (_u: string, init: { body: string }) => okBody(JSON.parse(init.body).domains))
    const out = await classifyDomains(domains)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out.ok && out.results.map((r) => r.domain)).toEqual(domains)
  })

  it('keeps earlier batches when a later one fails', async () => {
    const domains = Array.from({ length: CRAWL_BATCH_MAX + 1 }, (_, i) => `d${i}.com`)
    fetchMock.mockResolvedValueOnce(okBody(domains.slice(0, CRAWL_BATCH_MAX))).mockResolvedValueOnce(new Response('x', { status: 502 }))
    const out = await classifyDomains(domains)
    expect(out.ok).toBe(false)
    expect(!out.ok && out.error).toBe('http_502')
    expect(out.results).toHaveLength(CRAWL_BATCH_MAX)
  })

  it('maps 401 to unauthorized and network errors to unreachable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    expect((await classifyDomains(['a.com'])).ok === false && 'unauthorized').toBe('unauthorized')
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    const out = await classifyDomains(['a.com'])
    expect(!out.ok && out.error).toBe('unreachable')
  })

  it('drops malformed rows and rejects a bad envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, results: [row('a.com'), { domain: 'b.com', verdict: 'maybe' }, 'x'] })))
    const out = await classifyDomains(['a.com', 'b.com'])
    expect(out.ok && out.results.map((r) => r.domain)).toEqual(['a.com'])
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
    expect(await classifyDomains(['a.com'])).toEqual({ ok: false, error: 'bad_response', results: [] })
  })
})
