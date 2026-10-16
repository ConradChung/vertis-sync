import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Owner gate passes; the route logic is what's under test.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) } }),
}))
const logEvent = vi.fn()
vi.mock('@/lib/db/service', () => ({ logEvent: (...a: unknown[]) => logEvent(...a), isDbError: () => false }))

import { GET as accountsGET } from '@/app/api/instantly/accounts/route'
import { GET as campaignsGET } from '@/app/api/instantly/campaigns/route'
import { GET as analyticsGET } from '@/app/api/instantly/analytics/route'
import { POST as webhookPOST } from '@/app/api/webhooks/instantly/route'
import { clearInstantlyCache } from '@/lib/adapters/instantly'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  delete process.env.INSTANTLY_API_KEY
  clearInstantlyCache()
  logEvent.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('Instantly routes without INSTANTLY_API_KEY', () => {
  it.each([
    ['accounts', accountsGET],
    ['campaigns', campaignsGET],
    ['analytics', analyticsGET],
  ])('%s → 200 {configured:false} and no upstream call', async (_n, GET) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await GET(new Request('http://localhost/api/instantly/x'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ configured: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Instantly routes with a key (mocked fetch)', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_KEY = 'k'
  })

  it('accounts → mapped accounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [{ email: 'a@x.com', status: 1, warmup_status: 1, stat_warmup_score: 90, daily_limit: 30, secret: 'x' }] })))
    const res = await accountsGET(new Request('http://localhost/api/instantly/accounts'))
    expect(await res.json()).toEqual({
      configured: true,
      accounts: [{ email: 'a@x.com', status: 'active', warmup_status: 'active', warmup_score: 90, daily_limit: 30 }],
    })
  })

  it('upstream failure → 502 with a generic code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await campaignsGET(new Request('http://localhost/api/instantly/campaigns'))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ configured: true, error: 'instantly_unreachable', upstream_status: 500 })
  })
})

describe('POST /api/webhooks/instantly', () => {
  beforeEach(() => {
    process.env.INSTANTLY_WEBHOOK_SECRET = 'wh-secret'
  })
  const post = (secret: string | null, body: string) =>
    webhookPOST(new Request(`http://localhost/api/webhooks/instantly${secret ? `?secret=${secret}` : ''}`, { method: 'POST', body }))
  const reply = JSON.stringify({ event_type: 'reply_received', lead_email: 'a@x.com', campaign_id: 'c1', reply_text: 'hi' })

  it('401 on a wrong or missing secret, without touching the db', async () => {
    expect((await post('nope', reply)).status).toBe(401)
    expect((await post(null, reply)).status).toBe(401)
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('maps and logs; 200 {ok:true} for a new event and for a duplicate', async () => {
    logEvent.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce(null)
    const a = await post('wh-secret', reply)
    const b = await post('wh-secret', reply)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(await a.json()).toMatchObject({ ok: true, duplicate: false })
    expect(await b.json()).toMatchObject({ ok: true, duplicate: true })
    expect(logEvent).toHaveBeenCalledTimes(2)
    const [first] = logEvent.mock.calls[0]
    expect(first).toMatchObject({ type: 'reply', source: 'instantly', campaign_id: 'c1', lead_email: 'a@x.com', title: 'Reply from a@x.com' })
    expect(first.webhook_id).toBe(logEvent.mock.calls[1][0].webhook_id)
  })

  it('413 when Content-Length declares more than 128 KB, before reading', async () => {
    const req = new Request('http://localhost/api/webhooks/instantly?secret=wh-secret', {
      method: 'POST',
      body: reply,
      headers: { 'content-length': String(200 * 1024) },
    })
    const res = await webhookPOST(req)
    expect(res.status).toBe(413)
    expect(req.bodyUsed).toBe(false)
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('413 when the streamed body passes 128 KB in bytes (no Content-Length), and cancels the stream', async () => {
    let cancelled = false
    let pulls = 0
    // 3-byte characters: 50k of them is 150 KB in bytes but only 50k UTF-16 units.
    const chunk = new TextEncoder().encode('€'.repeat(10_000)) // 30 KB
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++
        if (pulls > 50) return c.close()
        c.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const req = new Request('http://localhost/api/webhooks/instantly?secret=wh-secret', {
      method: 'POST',
      body: stream,
      // @ts-expect-error -- Node's undici requires duplex for streamed bodies
      duplex: 'half',
    })
    const res = await webhookPOST(req)
    expect(res.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('400 on a non-JSON body', async () => {
    expect((await post('wh-secret', 'not json')).status).toBe(400)
    expect((await post('wh-secret', '[1,2]')).status).toBe(400)
  })
})
