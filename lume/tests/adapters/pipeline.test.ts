import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '@/lib/adapters/pipeline'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const CB = `approve:${ID}`

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('pipeline.decide', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
    process.env.LUME_ACTION_SECRET = 'shh-action'
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the callback_data to the telegram-inbox entrypoint with the shared secret and a timeout', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, claimed: true, action: 'approve', target_id: ID }))

    const result = await decide(CB)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://proj.supabase.co/functions/v1/telegram-inbox')
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-lume-secret')).toBe('shh-action')
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ callback_data: CB })
    expect(init?.signal).toBeInstanceOf(AbortSignal)

    expect(result).toEqual({ ok: true, claimed: true, action: 'approve', target_id: ID })
  })

  it('passes through claimed:false and claimed:null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, claimed: false, action: 'approve', target_id: ID }))
    expect(await decide(CB)).toMatchObject({ ok: true, claimed: false })

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, claimed: null, action: 'push_cancel', target_id: ID }))
    expect(await decide(`push_cancel:${ID}`)).toMatchObject({ ok: true, claimed: null })
  })

  it('maps 400 and 500 JSON errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { ok: false, error: 'bad callback_data' }))
    expect(await decide(CB)).toEqual({ ok: false, status: 400, error: 'bad callback_data' })

    fetchMock.mockResolvedValueOnce(jsonResponse(500, { ok: false, error: 'handler failed' }))
    expect(await decide(CB)).toEqual({ ok: false, status: 500, error: 'handler failed' })
  })

  it('maps a plain-text 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
    expect(await decide(CB)).toEqual({ ok: false, status: 401, error: 'Unauthorized' })
  })

  it('refuses malformed callback_data locally without calling the network', async () => {
    expect(await decide('bar_loc:' + ID)).toEqual({ ok: false, status: 400, error: 'bad callback_data' })
    expect(await decide('')).toMatchObject({ ok: false, status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a timeout as status 0', async () => {
    const err = new DOMException('The operation timed out', 'TimeoutError')
    fetchMock.mockRejectedValueOnce(err)
    expect(await decide(CB)).toEqual({ ok: false, status: 0, error: 'timeout' })
  })

  it('fails closed when the entrypoint is not configured', async () => {
    delete process.env.LUME_ACTION_SECRET
    expect(await decide(CB)).toEqual({ ok: false, status: 0, error: 'pipeline entrypoint not configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
