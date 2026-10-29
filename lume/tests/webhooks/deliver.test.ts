import { beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ getWebhook: vi.fn(), recordDelivery: vi.fn() }))
vi.mock('@/lib/webhooks/store', () => hooks)
const ops = vi.hoisted(() => ({ listVerticals: vi.fn(), listOperators: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)
const dns = vi.hoisted(() => ({ resolvePublicHost: vi.fn(), pinnedLookup: vi.fn(() => () => {}) }))
vi.mock('@/lib/webhooks/dns', () => dns)
const next = vi.hoisted(() => ({ after: vi.fn() }))
vi.mock('next/server', () => next)
vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
import { feed } from '../stubs/feed'

import { deliver, pushForItem, sendPush } from '@/lib/webhooks/deliver'
import { verifySignature } from '@/lib/webhooks/push'

const HOOK = { vertical_id: 'v-1', url: 'https://grok.test/hook', secret: 's'.repeat(32) }
const PAYLOAD = { type: 'positive_reply' as const, vertical: 'Roofers', item_id: 'u-1', summary: 'New positive reply from Ada (Acme). Check /operator.', link: 'https://lume.test/operator' }
const V = { id: 'v-1', name: 'Roofers', campaign_ids: ['c-1'], scopes: ['replies'], is_default: false, created_at: '', archived_at: null }

beforeEach(() => {
  vi.resetAllMocks()
  feed.rows.length = 0
  ops.listVerticals.mockResolvedValue([V])
  ops.listOperators.mockResolvedValue([])
  hooks.getWebhook.mockResolvedValue(HOOK)
  dns.resolvePublicHost.mockResolvedValue({ address: '104.18.2.3', family: 4 })
  dns.pinnedLookup.mockImplementation(() => () => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('deliver', () => {
  it('POSTs the JSON body signed with HMAC-SHA256 over "<timestamp>.<body>", with a 5 s timeout', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const out = await deliver(HOOK, PAYLOAD, { fetch, retryDelayMs: 0 })
    expect(out).toMatchObject({ ok: true, status: 200, attempts: 1 })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://grok.test/hook')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(PAYLOAD)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.redirect).toBe('manual')
    // the connection is pinned to the address that was checked
    expect(dns.resolvePublicHost).toHaveBeenCalledWith('grok.test')
    expect(dns.pinnedLookup).toHaveBeenCalledWith({ address: '104.18.2.3', family: 4 })
    expect(init.dispatcher).toBeDefined()
    expect(verifySignature(HOOK.secret, init.body, init.headers['X-Lume-Timestamp'], init.headers['X-Lume-Signature'])).toBe(true)
  })

  it('retries once on a 5xx, timeout or network error; never on a 4xx', async () => {
    const f5 = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('', { status: 200 }))
    expect(await deliver(HOOK, PAYLOAD, { fetch: f5, retryDelayMs: 0 })).toMatchObject({ ok: true, attempts: 2 })
    const fe = vi.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }))
    expect(await deliver(HOOK, PAYLOAD, { fetch: fe, retryDelayMs: 0 })).toMatchObject({ ok: false, attempts: 2, error: 'timed out after 5000 ms' })
    const f4 = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    expect(await deliver(HOOK, PAYLOAD, { fetch: f4, retryDelayMs: 0 })).toMatchObject({ ok: false, attempts: 1, status: 404, error: 'HTTP 404' })
  })
})

describe('deliver: address checks', () => {
  it('a host that resolves to a private, loopback, link-local or CGNAT address is never contacted', async () => {
    dns.resolvePublicHost.mockRejectedValue(new Error('private_address'))
    const fetch = vi.fn()
    expect(await deliver(HOOK, PAYLOAD, { fetch, retryDelayMs: 0 })).toEqual({ ok: false, attempts: 0, error: 'private_address' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('sendPush', () => {
  it('records the outcome; a failure is a warn in the feed (owner only)', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    const out = await sendPush('v-1', PAYLOAD, { fetch, retryDelayMs: 0 })
    expect(out.ok).toBe(false)
    expect(hooks.recordDelivery).toHaveBeenCalledWith('v-1', false, 'HTTP 500')
    expect(feed.rows).toHaveLength(1)
    expect(feed.rows[0]).toMatchObject({ severity: 'warn', source: 'lume.webhooks', owner_only: true })
    expect(feed.rows[0].body).not.toContain(HOOK.secret)
  })

  it('no webhook set: nothing is sent', async () => {
    hooks.getWebhook.mockResolvedValue(null)
    const fetch = vi.fn()
    expect(await sendPush('v-1', PAYLOAD, { fetch })).toEqual({ ok: false, skipped: 'no_webhook' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('pushForItem', () => {
  it('routes the item to its vertical and sends after the response, never blocking', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    pushForItem({ campaign_id: 'c-1', scope: 'replies' }, { type: 'positive_reply', item_id: 'u-1', summary: 's', link: 'l' }, { fetch, retryDelayMs: 0 })
    expect(next.after).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    await next.after.mock.calls[0][0]()
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ type: 'positive_reply', vertical: 'Roofers', item_id: 'u-1', summary: 's', link: 'l' })
  })

  it('an item no vertical owns, or an owner-only item, is not pushed', async () => {
    const fetch = vi.fn()
    pushForItem({ campaign_id: 'other', scope: null }, { type: 'needs_confirmation', item_id: 'a', summary: 's', link: 'l' }, { fetch })
    await next.after.mock.calls[0][0]()
    pushForItem({ owner_only: true }, { type: 'needs_confirmation', item_id: 'a', summary: 's', link: 'l' }, { fetch })
    expect(next.after).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('outside a request scope it still runs, unawaited; errors never escape', async () => {
    next.after.mockImplementation(() => {
      throw new Error('outside request scope')
    })
    ops.listVerticals.mockRejectedValue(new Error('db down'))
    expect(() => pushForItem({ campaign_id: 'c-1' }, { type: 'positive_reply', item_id: 'u', summary: 's', link: 'l' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
  })
})
