import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import {
  classifyDomains,
  COLD_START_MARGIN_MS,
  CRAWL_BATCH_MAX,
  CRAWL_CALL_BUDGET_MS,
  RETRY_DELAY_MS,
  WORKER_DEADLINE_MAX_S,
} from '@/lib/crawl/worker'

const fetchMock = vi.fn()
const row = (domain: string, verdict = 'property_manager') => ({
  domain, verdict, confidence: 'high', reason: 'r', linkedin_url: null, doors_hint: '200 doors', property_type: 'multifamily', pages: ['/'],
})
const okBody = (domains: string[], timedOut: string[] = []) =>
  new Response(JSON.stringify({ ok: true, timed_out: timedOut.length, results: domains.map((d) => row(d, timedOut.includes(d) ? 'timed_out' : 'property_manager')) }))
const sent = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body) as { domains: string[]; deadline_s: number; rules?: string }
const many = (n: number) => Array.from({ length: n }, (_, i) => `d${i}.com`)

/** Fake clock: each fetch "takes" `perCallMs`; sleeps advance it too. */
let clock = 0
const now = () => clock
const sleep = vi.fn(async (ms: number) => {
  clock += ms
})
const tick = (perCallMs: number, respond: (body: { domains: string[] }) => Response) =>
  fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
    clock += perCallMs
    return respond(JSON.parse(init.body))
  })

beforeEach(() => {
  process.env.CRAWL_WORKER_URL = 'https://crawl.example.app/'
  process.env.CRAWL_WORKER_SECRET = 'worker_test_secret'
  clock = 0
  fetchMock.mockReset()
  sleep.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('crawl worker client', () => {
  it('is not_configured without env, never calls fetch, and hands everything back', async () => {
    delete process.env.CRAWL_WORKER_URL
    expect(await classifyDomains(['a.com'])).toEqual({ ok: false, error: 'not_configured', results: [], timedOut: [], notSent: ['a.com'] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the secret as a header only, and a worker deadline capped at 200 s', async () => {
    tick(1_000, (b) => okBody(b.domains))
    const out = await classifyDomains(['a.com'], { now, sleep })
    expect(out.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://crawl.example.app/classify')
    expect(init.headers['X-Worker-Secret']).toBe('worker_test_secret')
    expect(String(url) + init.body).not.toContain('worker_test_secret')
    expect(sent(0)).toEqual({ domains: ['a.com'], deadline_s: WORKER_DEADLINE_MAX_S })
  })

  it('passes custom rules through', async () => {
    tick(1_000, (b) => okBody(b.domains))
    await classifyDomains(['a.com'], { rules: 'HOA managers only', now, sleep })
    expect(sent(0).rules).toBe('HOA managers only')
  })

  it('splits into batches of 20 and keeps input order', async () => {
    tick(10_000, (b) => okBody(b.domains))
    const domains = many(CRAWL_BATCH_MAX * 2 + 3)
    const out = await classifyDomains(domains, { now, sleep })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sent(0).domains).toHaveLength(CRAWL_BATCH_MAX)
    expect(out.results.map((r) => r.domain)).toEqual(domains)
    expect(out.notSent).toEqual([])
  })

  it('treats 240 s as the budget for the whole call: later batches get what is left', async () => {
    tick(100_000, (b) => okBody(b.domains)) // each batch takes 100 s
    const out = await classifyDomains(many(CRAWL_BATCH_MAX * 3), { now, sleep })
    // batch 1 at t=0: min(200, 240-30)=200. batch 2 at t=100: (140-30)=110. batch 3 at t=200: (40-30)=10 < 20 → not sent.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sent(0).deadline_s).toBe(200)
    expect(sent(1).deadline_s).toBe(110)
    expect(out.ok).toBe(true)
    expect(out.results).toHaveLength(CRAWL_BATCH_MAX * 2)
    expect(out.notSent).toEqual(many(CRAWL_BATCH_MAX * 3).slice(CRAWL_BATCH_MAX * 2))
    expect(clock).toBeLessThanOrEqual(CRAWL_CALL_BUDGET_MS)
  })

  it('every batch fetch times out within the remaining budget, never beyond it', async () => {
    tick(150_000, (b) => okBody(b.domains))
    await classifyDomains(many(CRAWL_BATCH_MAX * 2), { now, sleep })
    for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(sent(1).deadline_s).toBe(Math.floor((CRAWL_CALL_BUDGET_MS - 150_000 - COLD_START_MARGIN_MS) / 1000))
  })

  it('collects worker timed_out rows separately for requeue', async () => {
    tick(1_000, (b) => okBody(b.domains, ['b.com']))
    const out = await classifyDomains(['a.com', 'b.com', 'c.com'], { now, sleep })
    expect(out.ok).toBe(true)
    expect(out.results.map((r) => r.domain)).toEqual(['a.com', 'c.com'])
    expect(out.timedOut).toEqual(['b.com'])
  })

  it('retries once after 5 s on a cold start (503 / connection refused), then succeeds', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response('waking', { status: 503 }))
      .mockImplementationOnce(async (_u: string, init: { body: string }) => okBody(JSON.parse(init.body).domains))
    const out = await classifyDomains(['a.com'], { now, sleep })
    expect(sleep).toHaveBeenCalledWith(RETRY_DELAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out.ok).toBe(true)

    fetchMock.mockReset()
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementationOnce(async () => okBody(['a.com']))
    expect((await classifyDomains(['a.com'], { now, sleep })).ok).toBe(true)
  })

  it('gives up after the one retry and hands the batch back as notSent', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 502 }))
    const out = await classifyDomains(['a.com', 'b.com'], { now, sleep })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ ok: false, error: 'unreachable', notSent: ['a.com', 'b.com'] })
  })

  it('never retries after a timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
    const out = await classifyDomains(['a.com'], { now, sleep })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ ok: false, error: 'timeout', notSent: ['a.com'] })
  })

  it('keeps earlier batches when a later one fails', async () => {
    const domains = many(CRAWL_BATCH_MAX + 1)
    fetchMock.mockResolvedValueOnce(okBody(domains.slice(0, CRAWL_BATCH_MAX))).mockResolvedValueOnce(new Response('x', { status: 500 }))
    const out = await classifyDomains(domains, { now, sleep })
    expect(out).toMatchObject({ ok: false, error: 'http_500', notSent: [domains[CRAWL_BATCH_MAX]] })
    expect(out.results).toHaveLength(CRAWL_BATCH_MAX)
  })

  it('maps 401 to unauthorized without retrying', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    const out = await classifyDomains(['a.com'], { now, sleep })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ ok: false, error: 'unauthorized' })
  })

  it('drops malformed rows and rejects a bad envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, results: [row('a.com'), { domain: 'b.com', verdict: 'maybe' }, 'x'] })))
    expect((await classifyDomains(['a.com', 'b.com'], { now, sleep })).results.map((r) => r.domain)).toEqual(['a.com'])
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
    expect(await classifyDomains(['a.com'], { now, sleep })).toMatchObject({ ok: false, error: 'bad_response', notSent: ['a.com'] })
  })
})
