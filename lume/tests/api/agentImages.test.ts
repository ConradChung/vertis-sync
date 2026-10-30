import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

/** POST /api/agent/images (upload) and GET /api/agent/images/<path> (view), Storage mocked. */

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  requireOwnerSession: vi.fn(),
  storeChatImage: vi.fn(),
  loadChatImage: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner, requireOwnerSession: h.requireOwnerSession }))
vi.mock('@/lib/agent/chatImages', () => ({ storeChatImage: h.storeChatImage, loadChatImage: h.loadChatImage }))

import { POST } from '@/app/api/agent/images/route'
import { GET } from '@/app/api/agent/images/[path]/route'
import { IMAGE_PATH_RE, MAX_IMAGE_BYTES } from '@/lib/agent/images'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const PATH = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.png'

const upload = (body: BodyInit, { name = 'Screen Shot.png', type = 'image/png' } = {}) =>
  POST(new Request(`https://lume.test/api/agent/images?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers: { 'Content-Type': type } }))

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session', user: {} })
  h.requireOwnerSession.mockResolvedValue({ ok: true, via: 'session', user: {} })
  h.storeChatImage.mockResolvedValue(undefined)
})

describe('POST /api/agent/images', () => {
  it('stores a real image under a fresh path with its sniffed type, ignoring the claimed type', async () => {
    const res = await upload(JPEG, { name: 'C:\\shots\\a.png', type: 'image/png' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.media_type).toBe('image/jpeg')
    expect(body.name).toBe('a.png')
    expect(body.path).toMatch(IMAGE_PATH_RE)
    expect(body.path.endsWith('.jpg')).toBe(true)
    expect(h.storeChatImage).toHaveBeenCalledWith(body.path, expect.any(Uint8Array), 'image/jpeg')
  })

  it('refuses a non-image even when it claims to be a png', async () => {
    const res = await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
    expect(res.status).toBe(415)
    expect((await res.json()).error).toBe('unsupported_media_type')
    expect(h.storeChatImage).not.toHaveBeenCalled()
  })

  it('refuses an image over the per-image cap', async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
    big.set(PNG)
    const res = await upload(big)
    expect(res.status).toBe(413)
    expect(h.storeChatImage).not.toHaveBeenCalled()
  })

  it('refuses an empty body', async () => {
    const res = await upload(new Uint8Array(0))
    expect(res.status).toBe(400)
  })

  it('runs the owner guard first', async () => {
    h.requireOwner.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) })
    const res = await upload(PNG)
    expect(res.status).toBe(401)
    expect(h.storeChatImage).not.toHaveBeenCalled()
  })

  it('a Storage failure is a 502 without detail', async () => {
    h.storeChatImage.mockRejectedValue(new Error('bucket exploded: secret detail'))
    const res = await upload(PNG)
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })
})

describe('GET /api/agent/images/<path>', () => {
  const view = (path: string) => GET(new Request(`https://lume.test/api/agent/images/${path}`), { params: Promise.resolve({ path }) })

  it('serves the bytes with the sniffed type, privately cached and never sniffed by the browser', async () => {
    h.loadChatImage.mockResolvedValue({ bytes: PNG, media_type: 'image/png' })
    const res = await view(PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toMatch(/private/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    expect(h.loadChatImage).toHaveBeenCalledWith(PATH)
  })

  it('404s a missing object and 400s a path outside the bucket rules', async () => {
    h.loadChatImage.mockResolvedValue(null)
    expect((await view(PATH)).status).toBe(404)
    expect((await view('..%2F..%2Fsecret.png')).status).toBe(400)
    expect((await view('lume.csv')).status).toBe(400)
    expect(h.loadChatImage).toHaveBeenCalledTimes(1)
  })

  it('needs the owner session', async () => {
    h.requireOwnerSession.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) })
    expect((await view(PATH)).status).toBe(401)
    expect(h.loadChatImage).not.toHaveBeenCalled()
  })
})
