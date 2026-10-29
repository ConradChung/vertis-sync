import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))
const hooks = vi.hoisted(() => ({ getWebhook: vi.fn(), setWebhook: vi.fn(), deleteWebhook: vi.fn() }))
vi.mock('@/lib/webhooks/store', async () => ({ ...hooks, toView: (await vi.importActual<typeof import('@/lib/webhooks/store')>('@/lib/webhooks/store')).toView }))
const ops = vi.hoisted(() => ({ getVertical: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)
const svc = vi.hoisted(() => ({ logEvent: vi.fn() }))
vi.mock('@/lib/db/service', async () => ({ ...(await vi.importActual<object>('@/lib/db/service')), ...svc }))
const del = vi.hoisted(() => ({ sendPush: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => del)

import { DELETE, GET, PUT } from '@/app/api/verticals/[id]/webhook/route'
import { POST as TEST } from '@/app/api/verticals/[id]/webhook/test/route'

const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
const SECRET = 'abcdefghijklmnopqrstuvwxyz012345'
const ROW = { vertical_id: VID, url: 'https://grok.test/hook', secret: SECRET, updated_at: 't', last_delivery_at: null, last_delivery_ok: null, last_error: null }
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/verticals/${VID}/webhook`, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', ...headers } })
const params = { params: Promise.resolve({ id: VID }) }

beforeEach(() => {
  vi.resetAllMocks()
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
  ops.getVertical.mockResolvedValue({ id: VID, name: 'Roofers', archived_at: null })
  hooks.setWebhook.mockImplementation(async (_v: string, url: string, secret: string) => ({ ...ROW, url, secret }))
})

describe('/api/verticals/<id>/webhook', () => {
  it('GET never returns the secret, only a mask (a bot may read)', async () => {
    hooks.getWebhook.mockResolvedValue(ROW)
    const res = await GET(req('GET', undefined, { cookie: 'lume_op=x' }), params)
    const text = await res.text()
    expect(text).not.toContain(SECRET)
    expect(JSON.parse(text).webhook).toMatchObject({ url: 'https://grok.test/hook', secret_masked: '••••2345' })
  })

  it('PUT with no secret and none stored generates one, returned once', async () => {
    hooks.getWebhook.mockResolvedValue(null)
    const res = await PUT(req('PUT', { url: 'https://grok.test/hook' }), params)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const b = await res.json()
    expect(b.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hooks.setWebhook).toHaveBeenCalledWith(VID, 'https://grok.test/hook', b.secret)
    expect(JSON.stringify(svc.logEvent.mock.calls)).not.toContain(b.secret)
  })

  it('PUT keeps the stored secret when none is given, and never echoes it', async () => {
    hooks.getWebhook.mockResolvedValue(ROW)
    const res = await PUT(req('PUT', { url: 'https://grok.test/new' }), params)
    expect(hooks.setWebhook).toHaveBeenCalledWith(VID, 'https://grok.test/new', SECRET)
    const text = await res.text()
    expect(text).not.toContain(SECRET)
    expect(JSON.parse(text).secret).toBeUndefined()
  })

  it('PUT refuses non-https and private hosts', async () => {
    expect((await PUT(req('PUT', { url: 'http://grok.test/hook' }), params)).status).toBe(400)
    expect(await (await PUT(req('PUT', { url: 'https://10.0.0.1/hook' }), params)).json()).toEqual({ error: 'private_host' })
  })

  it('writes are owner-session only: the bearer and any bot cookie are refused', async () => {
    expect((await PUT(req('PUT', { url: 'https://grok.test/hook' }, { authorization: 'Bearer internal-secret' }), params)).status).toBe(403)
    expect((await PUT(req('PUT', { url: 'https://grok.test/hook' }, { cookie: 'lume_op=x' }), params)).status).toBe(403)
    expect((await DELETE(req('DELETE', undefined, { cookie: 'lume_op=x' }), params)).status).toBe(403)
    expect((await TEST(req('POST', {}, { cookie: 'lume_op=x' }), params)).status).toBe(403)
    expect(hooks.setWebhook).not.toHaveBeenCalled()
    expect(del.sendPush).not.toHaveBeenCalled()
  })

  it('DELETE removes it', async () => {
    hooks.deleteWebhook.mockResolvedValue(true)
    expect(await (await DELETE(req('DELETE'), params)).json()).toEqual({ deleted: true })
  })

  it('Send test pushes a test event and returns the outcome; 404 without a webhook', async () => {
    del.sendPush.mockResolvedValue({ ok: true, status: 200, attempts: 1 })
    expect(await (await TEST(req('POST', {}), params)).json()).toEqual({ ok: true, status: 200, attempts: 1 })
    expect(del.sendPush.mock.calls[0][1]).toMatchObject({ type: 'test', vertical: 'Roofers', item_id: 'test' })
    del.sendPush.mockResolvedValue({ ok: false, skipped: 'no_webhook' })
    expect((await TEST(req('POST', {}), params)).status).toBe(404)
  })
})
