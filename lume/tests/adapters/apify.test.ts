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
