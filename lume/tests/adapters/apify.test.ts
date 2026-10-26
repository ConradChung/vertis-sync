import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApifyError, APIFY_MAX_ITEMS, datasetItems, lastSucceededDatasetId } from '@/lib/adapters/apify'

const fetchMock = vi.fn()
beforeEach(() => {
  process.env.APIFY_API_TOKEN = 'apify_test_token'
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof ApifyError ? e.code : 'other'
  }
  return 'resolved'
}

describe('apify adapter', () => {
  it('sends the token as a bearer header, never in the URL', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { defaultDatasetId: 'DS' } })))
    expect(await lastSucceededDatasetId('me/actor')).toBe('DS')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.apify.com/v2/acts/me~actor/runs/last?status=SUCCEEDED')
    expect(init.headers.Authorization).toBe('Bearer apify_test_token')
  })

  it('counts non-object items as skipped', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ a: 1 }, 'x', null, [1], { b: 2 }])))
    expect(await datasetItems('DS')).toEqual({ items: [{ a: 1 }, { b: 2 }], truncated: false, skipped: 3 })
  })

  it('caps at 20 000 items and reports truncation', async () => {
    const body = Array.from({ length: APIFY_MAX_ITEMS + 1 }, (_, i) => ({ i }))
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)))
    const r = await datasetItems('DS')
    expect(r.items).toHaveLength(APIFY_MAX_ITEMS)
    expect(r.truncated).toBe(true)
  })

  it('too_large from Content-Length before reading', async () => {
    const res = new Response('[]', { headers: { 'content-length': String(41 * 1024 * 1024) } })
    fetchMock.mockResolvedValue(res)
    expect(await code(datasetItems('DS'))).toBe('too_large')
  })

  it('too_large while streaming without a Content-Length', async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024).fill(32)
    let n = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ > 8) c.close()
        else c.enqueue(chunk)
      },
    })
    fetchMock.mockResolvedValue(new Response(body))
    expect(await code(datasetItems('DS'))).toBe('too_large')
    expect(n).toBeLessThanOrEqual(7)
  })

  it('timeout when the shared deadline has passed', async () => {
    const ctl = new AbortController()
    ctl.abort(new DOMException('deadline', 'TimeoutError'))
    fetchMock.mockRejectedValue(new DOMException('deadline', 'TimeoutError'))
    expect(await code(datasetItems('DS', ctl.signal))).toBe('timeout')
  })

  it('404 → not_found / no_succeeded_run', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    expect(await code(datasetItems('DS'))).toBe('not_found')
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    expect(await code(lastSucceededDatasetId('a~b'))).toBe('no_succeeded_run')
  })
})

describe('apify adapter — store, actors, runs', () => {
  it('searches the Store and maps stats, success rate and pricing', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            total: 2,
            items: [
              {
                username: 'compass',
                name: 'crawler-google-places',
                title: 'Google Maps Scraper',
                description: 'maps',
                actorReviewRating: 4.7,
                actorReviewCount: 1800,
                stats: { totalUsers: 600000, totalUsers30Days: 44000, publicActorRunStats30Days: { TOTAL: 1000, SUCCEEDED: 960 } },
                currentPricingInfo: { pricingModel: 'PAY_PER_EVENT' },
              },
              { title: 'no username' },
            ],
          },
        })
      )
    )
    const { searchStore } = await import('@/lib/adapters/apify')
    const r = await searchStore('google maps', 5)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.apify.com/v2/store?search=google+maps&limit=5')
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ id: 'compass/crawler-google-places', rating: 4.7, users30d: 44000, successRate30d: 96 })
  })

  it('reads the default build input schema from actorDefinition.input', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { actorDefinition: { input: { properties: { q: { type: 'string' } } }, minMemoryMbytes: 512 } } }))
    )
    const { getActorInputSchema } = await import('@/lib/adapters/apify')
    const r = await getActorInputSchema('compass/crawler-google-places')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.apify.com/v2/acts/compass~crawler-google-places/builds/default')
    expect(r).toMatchObject({ schema: { properties: { q: { type: 'string' } } }, minMemoryMb: 512 })
  })

  it('starts a run with the limits as query params and the input as the body', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'RUN12345', actId: 'ACT1', status: 'READY', defaultDatasetId: 'DS1' } }), { status: 201 })
    )
    const { startRun } = await import('@/lib/adapters/apify')
    const run = await startRun('me/actor', { q: 'roofers' }, { timeout: 3600, maxTotalChargeUsd: 20, maxItems: 10000 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    const u = new URL(url)
    expect(u.pathname).toBe('/v2/acts/me~actor/runs')
    expect(Object.fromEntries(u.searchParams)).toEqual({ timeout: '3600', maxTotalChargeUsd: '20', maxItems: '10000' })
    expect(JSON.parse(init.body)).toEqual({ q: 'roofers' })
    expect(url).not.toContain('apify_test_token')
    expect(run).toMatchObject({ id: 'RUN12345', datasetId: 'DS1', consoleUrl: 'https://console.apify.com/actors/ACT1/runs/RUN12345' })
  })

  it('a refused start surfaces Apify’s message as upstream', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Monthly usage hard limit exceeded' } }), { status: 402 }))
    const { startRun } = await import('@/lib/adapters/apify')
    await expect(startRun('me/actor', {}, { timeout: 60, maxTotalChargeUsd: 1 })).rejects.toMatchObject({
      code: 'upstream',
      status: 402,
      message: expect.stringContaining('hard limit'),
    })
  })

  it('getRun adds the dataset item count; 404 is not_found', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'RUN12345', status: 'SUCCEEDED', defaultDatasetId: 'DS1', usageTotalUsd: 3.2 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { itemCount: 812 } })))
    const { getRun } = await import('@/lib/adapters/apify')
    expect(await getRun('RUN12345')).toMatchObject({ status: 'SUCCEEDED', itemCount: 812, usageTotalUsd: 3.2 })
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    expect(await code(getRun('NOPE12345'))).toBe('not_found')
  })
})
