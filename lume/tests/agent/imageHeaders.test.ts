import { describe, expect, it } from 'vitest'
import { API_MAX_EDGE, imageDimensions, validateImageUpload } from '@/lib/agent/images'
import { gif, jpeg, png, webpLossless, webpLossy, webpExtended } from '../stubs/imageHeaders'

describe('imageDimensions', () => {
  it('reads PNG (IHDR)', () => {
    expect(imageDimensions(png(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })
  it('reads JPEG (first SOF segment, after APP segments)', () => {
    expect(imageDimensions(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 })
    expect(imageDimensions(jpeg(640, 480, { progressive: true }))).toEqual({ width: 640, height: 480 })
  })
  it('reads GIF (logical screen)', () => {
    expect(imageDimensions(gif(320, 200))).toEqual({ width: 320, height: 200 })
  })
  it('reads WebP lossy (VP8), lossless (VP8L) and extended (VP8X)', () => {
    expect(imageDimensions(webpLossy(800, 600))).toEqual({ width: 800, height: 600 })
    expect(imageDimensions(webpLossless(1000, 750))).toEqual({ width: 1000, height: 750 })
    expect(imageDimensions(webpExtended(9000, 20))).toEqual({ width: 9000, height: 20 })
  })
  it('returns null for a header it cannot parse', () => {
    const cut = png(10, 10).slice(0, 20)
    expect(imageDimensions(cut)).toBeNull()
    const noSof = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xd9])
    expect(imageDimensions(noSof)).toBeNull()
    const badVp8 = webpLossy(10, 10)
    badVp8[23] = 0 // broken start code
    expect(imageDimensions(badVp8)).toBeNull()
    expect(imageDimensions(png(0, 10))).toBeNull()
    expect(imageDimensions(new TextEncoder().encode('not an image at all'))).toBeNull()
  })
})

describe('validateImageUpload: dimensions', () => {
  it('accepts each format at the 8000 px limit', () => {
    expect(API_MAX_EDGE).toBe(8000)
    for (const b of [png(8000, 10), jpeg(10, 8000), gif(8000, 8000), webpLossy(8000, 1), webpLossless(1, 8000), webpExtended(8000, 8000)]) {
      expect(validateImageUpload(b).ok).toBe(true)
    }
  })
  it('refuses each format past 8000 px on either edge', () => {
    for (const b of [png(8001, 10), jpeg(10, 8001), gif(8001, 1), webpLossy(8001, 1), webpLossless(1, 8001), webpExtended(9000, 20)]) {
      expect(validateImageUpload(b)).toEqual({ ok: false, error: 'too_many_pixels' })
    }
  })
  it('refuses a real signature whose header cannot be parsed', () => {
    expect(validateImageUpload(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))).toEqual({ ok: false, error: 'unreadable' })
  })
})
