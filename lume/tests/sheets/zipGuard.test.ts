import { describe, expect, it } from 'vitest'
import { deflateSync, strToU8 } from 'fflate'
import { scanXlsxZip } from '@/lib/sheets/zipGuard'

/**
 * Crafted zips (review item 2). JSZip, which exceljs uses, opens the entries
 * the CENTRAL DIRECTORY lists; the guard must inflate exactly those, under
 * exceljs's name rules, and refuse a zip whose central directory and local
 * headers disagree.
 */

interface Entry {
  name: string
  data: Uint8Array
  /** Name written in the local header (default: the same). */
  localName?: string
  /** Bytes inserted before this entry's local header (a sequential reader stops there). */
  junkBefore?: Uint8Array
  stored?: boolean
  /** Extra-field bytes on the central-directory record / the local header. */
  cdExtra?: number[]
  localExtra?: number[]
}

const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff]
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

/** Layout tampering for the adversarial cases. */
interface Tamper {
  /** Entry count written in the EOCD (default: the real count). */
  eocdCount?: number
  /** Bytes between the end of the central directory and the EOCD (cdSize is NOT grown). */
  gapBeforeEocd?: Uint8Array
  /** Bytes after the EOCD record (beyond its comment). */
  trailing?: Uint8Array
  /** Write 0xffff / 0xffffffff in the EOCD (zip64 markers). */
  zip64?: boolean
}

/** A minimal zip writer (no CRC check in JSZip by default; the guard never needs one). */
function zip(entries: Entry[], t: Tamper = {}): Uint8Array {
  const parts: number[] = []
  const cd: number[] = []
  for (const e of entries) {
    if (e.junkBefore) parts.push(...e.junkBefore)
    const offset = parts.length
    const body = e.stored ? e.data : deflateSync(e.data)
    const method = e.stored ? 0 : 8
    const name = strToU8(e.name)
    const lname = strToU8(e.localName ?? e.name)
    const lx = e.localExtra ?? []
    const cx = e.cdExtra ?? []
    parts.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0), ...u32(0), ...u32(body.length), ...u32(e.data.length), ...u16(lname.length), ...u16(lx.length), ...lname, ...lx)
    for (const b of body) parts.push(b)
    cd.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0), ...u32(0), ...u32(body.length), ...u32(e.data.length), ...u16(name.length), ...u16(cx.length), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name, ...cx)
  }
  const cdOffset = parts.length
  parts.push(...cd)
  if (t.gapBeforeEocd) parts.push(...t.gapBeforeEocd)
  const n = t.eocdCount ?? entries.length
  parts.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(t.zip64 ? 0xffff : n), ...u16(t.zip64 ? 0xffff : n), ...u32(cd.length), ...u32(t.zip64 ? 0xffffffff : cdOffset), ...u16(0))
  if (t.trailing) parts.push(...t.trailing)
  return new Uint8Array(parts)
}

/** CRC-32 (what JSZip checks before it trusts a unicode path field). */
const crcT = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff
  for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/** Info-ZIP unicode path (0x7075) or comment (0x6375) extra field: JSZip renames the entry from it. */
function unicodeExtra(id: 0x7075 | 0x6375, orig: string, path: string): number[] {
  const body = [1, ...u32(crc32(strToU8(orig))), ...strToU8(path)]
  return [...u16(id), ...u16(body.length), ...body]
}

const WORKBOOK = { name: 'xl/workbook.xml', data: strToU8('<workbook><sheets><sheet name="a"/></sheets></workbook>') }
const cells = (n: number) => strToU8(`<sheetData><row>${'<c r="A1"><v>1</v></c>'.repeat(n)}</row></sheetData>`)

describe('scanXlsxZip walks the central directory', () => {
  it('a well-formed archive is counted', () => {
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'xl/worksheets/sheet1.xml', data: cells(3) }]))).toEqual({ ok: true, sheets: 1, cells: 3 })
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'xl/worksheets/sheet1.xml', data: cells(3), stored: true }]))).toEqual({ ok: true, sheets: 1, cells: 3 })
  })

  it('counts cells in names exceljs reads as worksheets: a leading slash, a trailing suffix, a prefix', () => {
    for (const name of ['/xl/worksheets/sheet1.xml', 'xl/worksheets/sheet1.xml.bak', 'zz/xl/worksheets/sheet7.xml']) {
      expect(scanXlsxZip(zip([WORKBOOK, { name, data: cells(200) }]), { maxCells: 100 }), name).toEqual({ ok: false, error: 'too_many_cells' })
    }
  })

  it('finds the workbook under a leading slash, as exceljs does', () => {
    expect(scanXlsxZip(zip([{ ...WORKBOOK, name: '/xl/workbook.xml' }]))).toMatchObject({ ok: true, sheets: 1 })
  })

  it('a bomb hidden from a sequential local-header reader (junk before it) is still inflated and refused', () => {
    const bomb = zip([WORKBOOK, { name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(5 * 1024 * 1024), junkBefore: new Uint8Array(64).fill(0x41) }])
    expect(bomb.length).toBeLessThan(100_000)
    expect(scanXlsxZip(bomb, { maxUncompressed: 1024 * 1024 })).toEqual({ ok: false, error: 'too_large_uncompressed' })
  })

  it('refuses a central directory that disagrees with the local header', () => {
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'xl/worksheets/sheet1.xml', localName: 'xl/worksheets/sheetX.xml', data: cells(1) }]))).toEqual({ ok: false, error: 'not_xlsx' })
    // Method mismatch: the CD says stored, the local header says deflate.
    const z = zip([WORKBOOK, { name: 'xl/worksheets/sheet1.xml', data: cells(1), stored: true }])
    const local = z.indexOf(0x50, z.findIndex((_, i) => i > 10 && z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 3 && z[i + 3] === 4))
    z[local + 8] = 8
    expect(scanXlsxZip(z)).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('refuses duplicate names (after the leading-slash rule), a missing workbook, truncation and garbage', () => {
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'xl/worksheets/sheet1.xml', data: cells(1) }, { name: '/xl/worksheets/sheet1.xml', data: cells(1) }]))).toEqual({ ok: false, error: 'not_xlsx' })
    expect(scanXlsxZip(zip([{ name: 'xl/worksheets/sheet1.xml', data: cells(1) }]))).toEqual({ ok: false, error: 'not_xlsx' })
    const good = zip([WORKBOOK])
    expect(scanXlsxZip(good.subarray(0, good.length - 5))).toEqual({ ok: false, error: 'not_xlsx' })
    expect(scanXlsxZip(strToU8('PK\x03\x04 not really'))).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('refuses a central-directory record hidden past the EOCD count (JSZip reads on while the signature matches)', () => {
    // The EOCD says 2 entries; a third, a deflate bomb, sits inside the directory. JSZip would inflate it.
    const entries = [WORKBOOK, { name: 'xl/worksheets/sheet1.xml', data: cells(1) }, { name: 'docProps/custom.xml', data: new Uint8Array(5 * 1024 * 1024) }]
    const hidden = zip(entries, { eocdCount: 2 })
    expect(hidden.length).toBeLessThan(100_000)
    expect(scanXlsxZip(hidden)).toEqual({ ok: false, error: 'not_xlsx' })
    expect(scanXlsxZip(zip(entries), { maxUncompressed: 1024 * 1024 })).toEqual({ ok: false, error: 'too_large_uncompressed' }) // honest count: caught by the cap
  })

  it('refuses a gap between the central directory and the EOCD (JSZip would shift every offset by it)', () => {
    expect(scanXlsxZip(zip([WORKBOOK], { gapBeforeEocd: new Uint8Array(46).fill(0x20) }))).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('refuses bytes after the EOCD, and zip64 markers', () => {
    expect(scanXlsxZip(zip([WORKBOOK], { trailing: new Uint8Array(10) }))).toEqual({ ok: false, error: 'not_xlsx' })
    expect(scanXlsxZip(zip([WORKBOOK], { zip64: true }))).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('the hidden-record bomb never reaches exceljs', async () => {
    const { parseSpreadsheet } = await import('@/lib/sheets/parse')
    const bomb = zip([WORKBOOK, { name: 'xl/worksheets/sheet1.xml', data: cells(1) }, { name: 'docProps/custom.xml', data: new Uint8Array(5 * 1024 * 1024) }], { eocdCount: 2 })
    expect(await parseSpreadsheet(bomb, 'xlsx')).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('refuses the unicode-path directory alias: "pad/" that JSZip renames to docProps/custom.xml (a bomb), before inflating', async () => {
    const bomb = zip([WORKBOOK, { name: 'pad/', data: new Uint8Array(5 * 1024 * 1024), cdExtra: unicodeExtra(0x7075, 'pad/', 'docProps/custom.xml') }])
    expect(bomb.length).toBeLessThan(100_000)
    const t = performance.now()
    // Even with no uncompressed cap at all: refused on the header, never inflated.
    expect(scanXlsxZip(bomb, { maxUncompressed: Number.MAX_SAFE_INTEGER })).toEqual({ ok: false, error: 'not_xlsx' })
    expect(performance.now() - t).toBeLessThan(200)
    const { parseSpreadsheet } = await import('@/lib/sheets/parse')
    expect(await parseSpreadsheet(bomb, 'xlsx')).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('refuses the unicode-path sheet alias that would dodge the cell count, through parseSpreadsheet too', async () => {
    const alias = zip([WORKBOOK, { name: 'docProps/s.xml', data: cells(200), cdExtra: unicodeExtra(0x7075, 'docProps/s.xml', 'xl/worksheets/sheet1.xml') }])
    expect(scanXlsxZip(alias, { maxCells: 100 })).toEqual({ ok: false, error: 'not_xlsx' })
    const { parseSpreadsheet } = await import('@/lib/sheets/parse')
    expect(await parseSpreadsheet(alias, 'xlsx', { maxCells: 100 })).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('refuses unicode path / comment extra fields on the local header too, and a 0x6375 comment field', () => {
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'a.xml', data: cells(1), localExtra: unicodeExtra(0x7075, 'a.xml', 'b.xml') }]))).toEqual({ ok: false, error: 'not_xlsx' })
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'a.xml', data: cells(1), cdExtra: unicodeExtra(0x6375, 'a.xml', 'note') }]))).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('a name ending in "/" must be an empty directory entry; other extra fields are fine', () => {
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'pad/', data: new Uint8Array(5 * 1024 * 1024) }]), { maxUncompressed: Number.MAX_SAFE_INTEGER })).toEqual({ ok: false, error: 'not_xlsx' })
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'pad/', data: new Uint8Array(0), stored: true }]))).toMatchObject({ ok: true })
    // An ordinary extended-timestamp field (0x5455) is what real zips carry.
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'xl/worksheets/sheet1.xml', data: cells(2), cdExtra: [...u16(0x5455), ...u16(5), 1, 0, 0, 0, 0] }]))).toEqual({ ok: true, sheets: 1, cells: 2 })
    // A malformed extra block is refused.
    expect(scanXlsxZip(zip([WORKBOOK, { name: 'a.xml', data: cells(1), cdExtra: [...u16(0x5455), ...u16(40), 1] }]))).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('caps the entry count from the central directory', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `xl/media/i${i}.png`, data: strToU8('x') }))
    expect(scanXlsxZip(zip([WORKBOOK, ...many]), { maxEntries: 20 })).toEqual({ ok: false, error: 'not_xlsx' })
  })
})
