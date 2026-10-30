// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareImage, uploadChatImage, type ImageCodec } from '@/lib/agent/imageClient'
import { IMAGE_MAX_EDGE, IMAGE_TARGET_BYTES, RAW_IMAGE_MAX_BYTES } from '@/lib/agent/images'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIG = [0xff, 0xd8, 0xff, 0xe0]

function file(sig: number[], size: number, name: string, type = '') {
  const b = new Uint8Array(size)
  b.set(sig)
  return new File([b], name, { type })
}

/** A codec that reports fixed dimensions and encodes to a blob of a size chosen by the test. */
function codec(width: number, height: number, sizeFor: (type: string, q: number | undefined, w: number, h: number) => number): ImageCodec & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    decode: async () => ({
      width,
      height,
      encode: async (w, h, type, q) => {
        calls.push({ w, h, type, q })
        const sig = type === 'image/png' ? PNG_SIG : JPEG_SIG
        const b = new Uint8Array(sizeFor(type, q, w, h))
        b.set(sig)
        return new Blob([b], { type })
      },
      close: () => {},
    }),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('prepareImage', () => {
  it('keeps a small image that fits as it is (no re-encode)', async () => {
    const c = codec(800, 600, () => 1)
    const f = file(PNG_SIG, 1000, 'a.png', 'image/png')
    const r = await prepareImage(f, c)
    expect(r).toMatchObject({ ok: true, name: 'a.png', media_type: 'image/png' })
    if (r.ok) expect(r.blob).toBe(f)
    expect(c.calls).toEqual([])
  })

  it('downscales a large screenshot so the long edge is 1568, staying PNG when that fits', async () => {
    const c = codec(3136, 1960, () => 500_000)
    const r = await prepareImage(file(PNG_SIG, 3_000_000, 'shot.png', 'image/png'), c)
    expect(r).toMatchObject({ ok: true, name: 'shot.png', media_type: 'image/png' })
    expect(c.calls[0]).toEqual({ w: IMAGE_MAX_EDGE, h: 980, type: 'image/png', q: undefined })
  })

  it('re-encodes to JPEG, lowering quality, when the PNG is still too big', async () => {
    const c = codec(1000, 1000, (type, q) => (type === 'image/png' ? IMAGE_TARGET_BYTES * 2 : q && q > 0.75 ? IMAGE_TARGET_BYTES + 1 : 400_000))
    const r = await prepareImage(file(PNG_SIG, IMAGE_TARGET_BYTES + 10, 'big.png', 'image/png'), c)
    expect(r).toMatchObject({ ok: true, name: 'big.jpg', media_type: 'image/jpeg' })
    if (r.ok) expect(r.blob.size).toBeLessThanOrEqual(IMAGE_TARGET_BYTES)
  })

  it('shrinks further when even low-quality JPEG is too big, and gives up with too_large', async () => {
    const shrinks = codec(1000, 1000, (_t, _q, w) => (w > 600 ? IMAGE_TARGET_BYTES * 3 : 100))
    expect(await prepareImage(file(JPEG_SIG, IMAGE_TARGET_BYTES * 2, 'p.jpg', 'image/jpeg'), shrinks)).toMatchObject({ ok: true })
    const never = codec(1000, 1000, () => IMAGE_TARGET_BYTES * 3)
    expect(await prepareImage(file(JPEG_SIG, IMAGE_TARGET_BYTES * 2, 'p.jpg', 'image/jpeg'), never)).toEqual({ ok: false, error: 'too_large' })
  })

  it('refuses a file that is not really an image, whatever its type says', async () => {
    const c = codec(10, 10, () => 1)
    expect(await prepareImage(new File(['%PDF-1.7 hello'], 'doc.png', { type: 'image/png' }), c)).toEqual({ ok: false, error: 'unsupported_media_type' })
    expect(await prepareImage(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), c)).toEqual({ ok: false, error: 'unsupported_media_type' })
  })

  it('refuses a huge file before decoding it, and an undecodable one', async () => {
    const c = codec(10, 10, () => 1)
    const decode = vi.spyOn(c, 'decode')
    expect(await prepareImage(file(PNG_SIG, RAW_IMAGE_MAX_BYTES + 1, 'huge.png'), c)).toEqual({ ok: false, error: 'too_large' })
    expect(decode).not.toHaveBeenCalled()
    const broken: ImageCodec = { decode: async () => { throw new Error('bad') } }
    expect(await prepareImage(file(PNG_SIG, 100, 'b.png'), broken)).toEqual({ ok: false, error: 'decode' })
  })
})

describe('uploadChatImage', () => {
  it('posts the bytes, one image per request, and returns the reference', async () => {
    const ref = { path: '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.png', name: 'a.png', media_type: 'image/png' }
    const f = vi.fn(async () => Response.json(ref))
    vi.stubGlobal('fetch', f)
    const blob = new Blob([new Uint8Array(PNG_SIG)], { type: 'image/png' })
    expect(await uploadChatImage(blob, 'a b.png')).toEqual({ ok: true, ref })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/agent/images?name=a%20b.png')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(blob)
  })

  it('maps a refusal to its error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unsupported_media_type' }, { status: 415 })))
    expect(await uploadChatImage(new Blob(['x']), 'x')).toEqual({ ok: false, error: 'unsupported_media_type' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'too_many_pixels' }, { status: 422 })))
    expect(await uploadChatImage(new Blob(['x']), 'x')).toEqual({ ok: false, error: 'too_many_pixels' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await uploadChatImage(new Blob(['x']), 'x')).toEqual({ ok: false, error: 'upload' })
  })
})
