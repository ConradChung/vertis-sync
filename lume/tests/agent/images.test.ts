import { describe, expect, it } from 'vitest'
import {
  fitWithin,
  IMAGE_MAX_EDGE,
  IMAGE_PATH_RE,
  imageUrl,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  newImagePath,
  safeImageName,
  sniffImageType,
  validateImageUpload,
} from '@/lib/agent/images'
import { png } from '../stubs/imageHeaders'

const bytes = (...xs: (number | string)[]) => {
  const out: number[] = []
  for (const x of xs) {
    if (typeof x === 'string') for (const c of x) out.push(c.charCodeAt(0))
    else out.push(x)
  }
  return new Uint8Array([...out, ...new Array(32).fill(0)])
}

const PNG = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0)
const GIF87 = bytes('GIF87a')
const GIF89 = bytes('GIF89a')
const WEBP = bytes('RIFF', 0x10, 0, 0, 0, 'WEBP', 'VP8 ')

describe('sniffImageType', () => {
  it('recognises png, jpeg, gif and webp by their magic bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(GIF87)).toBe('image/gif')
    expect(sniffImageType(GIF89)).toBe('image/gif')
    expect(sniffImageType(WEBP)).toBe('image/webp')
  })
  it('refuses everything else, whatever it claims to be', () => {
    expect(sniffImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull()
    expect(sniffImageType(bytes('%PDF-1.7'))).toBeNull()
    expect(sniffImageType(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBeNull()
    expect(sniffImageType(bytes('BM'))).toBeNull()
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(sniffImageType(new Uint8Array(0))).toBeNull()
  })
})

describe('validateImageUpload', () => {
  it('returns the sniffed type', () => {
    expect(validateImageUpload(png(640, 480))).toEqual({ ok: true, media_type: 'image/png', width: 640, height: 480 })
  })
  it('refuses an empty body, a non-image and an oversize image', () => {
    expect(validateImageUpload(new Uint8Array(0))).toEqual({ ok: false, error: 'empty' })
    expect(validateImageUpload(bytes('hello world'))).toEqual({ ok: false, error: 'unsupported_media_type' })
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
    big.set(PNG.subarray(0, 8))
    expect(validateImageUpload(big)).toEqual({ ok: false, error: 'too_large' })
  })
  it('limits are sane', () => {
    expect(MAX_IMAGES).toBe(5)
    // Each image stays well under Vercel's 4.5 MB request-body cap (one per upload request).
    expect(MAX_IMAGE_BYTES).toBeLessThan(4.5 * 1024 * 1024)
    expect(IMAGE_MAX_EDGE).toBe(1568)
  })
})

describe('paths and names', () => {
  it('builds a path only the bucket regex accepts', () => {
    const p = newImagePath('image/jpeg')
    expect(p).toMatch(IMAGE_PATH_RE)
    expect(p.endsWith('.jpg')).toBe(true)
    expect(newImagePath('image/webp').endsWith('.webp')).toBe(true)
  })
  it('the path regex refuses traversal and other buckets', () => {
    for (const bad of ['../x.png', 'a/b.png', 'lume/0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.csv', '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.svg', '']) {
      expect(IMAGE_PATH_RE.test(bad), bad).toBe(false)
    }
    expect(IMAGE_PATH_RE.test('0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.png')).toBe(true)
  })
  it('imageUrl points at the authed proxy', () => {
    expect(imageUrl('0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.png')).toBe('/api/agent/images/0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.png')
  })
  it('safeImageName strips paths and control characters and caps the length', () => {
    expect(safeImageName('C:\\Users\\me\\Screenshot 1.png')).toBe('Screenshot 1.png')
    expect(safeImageName('/tmp/a\nb.png')).toBe('a b.png')
    expect(safeImageName('   ')).toBe('image')
    expect(safeImageName('x'.repeat(500)).length).toBeLessThanOrEqual(120)
  })
})

describe('fitWithin', () => {
  it('keeps small images as they are', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scaled: false })
  })
  it('scales the long edge down to 1568, keeping the aspect ratio', () => {
    expect(fitWithin(3136, 1000)).toEqual({ width: 1568, height: 500, scaled: true })
    expect(fitWithin(1000, 4000)).toEqual({ width: 392, height: 1568, scaled: true })
  })
  it('never returns a zero edge', () => {
    expect(fitWithin(100000, 10).height).toBeGreaterThanOrEqual(1)
  })
})
