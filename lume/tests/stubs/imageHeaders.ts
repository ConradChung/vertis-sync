/** Minimal, well-formed image headers for tests (enough bytes for the parsers, no pixel data). */

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const pad = (xs: number[], n = 16) => new Uint8Array([...xs, ...new Array(n).fill(0)])

export const png = (w: number, h: number) =>
  pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0])

/** SOI, an APP0 segment, then SOF0 (or SOF2 when progressive). */
export const jpeg = (w: number, h: number, o: { progressive?: boolean } = {}) =>
  pad([
    0xff, 0xd8,
    0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, o.progressive ? 0xc2 : 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3,
  ])

export const gif = (w: number, h: number) => pad([...ascii('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0])

const riff = (chunk: number[]) => pad([...ascii('RIFF'), ...le24(chunk.length + 4), 0, ...ascii('WEBP'), ...chunk])

export const webpLossy = (w: number, h: number) =>
  riff([...ascii('VP8 '), ...le24(10), 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w & 0x3fff), ...le16(h & 0x3fff)])

export const webpLossless = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return riff([...ascii('VP8L'), ...le24(5), 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff])
}

export const webpExtended = (w: number, h: number) => riff([...ascii('VP8X'), ...le24(10), 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)])
