import { Inflate } from 'fflate'
import { LIMITS } from '@/lib/sheets/model'

/**
 * Zip-bomb guard for an .xlsx, run BEFORE exceljs sees the bytes.
 *
 * exceljs opens the archive with JSZip, which reads the CENTRAL DIRECTORY
 * (not the local headers a streaming reader walks), so this guard walks the
 * same list: for every central-directory entry it checks the local header it
 * points at (same name bytes, same method, data inside the file and before
 * the directory) and refuses the zip when they disagree. Then it inflates
 * each entry's data (4 KB of input at a time, output counted and dropped)
 * and stops as soon as the real uncompressed total passes the cap — declared
 * sizes can lie, inflated bytes cannot.
 *
 * Names follow exceljs's rules (lib/xlsx/xlsx.js): one leading "/" is
 * stripped, `xl/workbook.xml` is the workbook, and any name MATCHING
 * /xl\/worksheets\/sheet(\d+)[.]xml/ (unanchored, so `/xl/…`,
 * `…sheet1.xml.bak` and `zz/xl/…` count) is a worksheet whose cells are
 * counted. Duplicate names after that rule, zip64, encryption and any method
 * other than stored / deflate are refused.
 */

export type ZipScan =
  | { ok: true; sheets: number; cells: number }
  | { ok: false; error: 'not_xlsx' | 'too_large_uncompressed' | 'too_many_sheets' | 'too_many_cells' }

type Fail = Exclude<ZipScan, { ok: true }>['error']

class Stop extends Error {
  constructor(readonly code: Fail) {
    super(code)
  }
}

const CHUNK = 4 * 1024
const SHEET_RE = /<(?:\w{1,12}:)?sheet[\s/>]/g
const CELL_RE = /<(?:\w{1,12}:)?c[\s/>]/g
/** Longer than any match, so one split across chunks is still seen (and counted once). */
const TAIL = 24
const WORKSHEET_NAME = /xl\/worksheets\/sheet(\d+)[.]xml/

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0

/** Matches that end past `from` (those ending inside the carried tail were counted already). */
function countFrom(s: string, re: RegExp, from: number): number {
  let n = 0
  re.lastIndex = 0
  for (let m = re.exec(s); m; m = re.exec(s)) if (m.index + m[0].length > from) n++
  return n
}

/** The end-of-central-directory record, searched backwards like JSZip; -1 when absent. */
function findEocd(b: Uint8Array): number {
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) if (u32(b, i) === SIG_EOCD) return i
  return -1
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

export function scanXlsxZip(
  bytes: Uint8Array,
  limits: { maxUncompressed?: number; maxSheets?: number; maxCells?: number; maxEntries?: number } = {}
): ZipScan {
  const maxUncompressed = limits.maxUncompressed ?? LIMITS.maxUncompressed
  const maxSheets = limits.maxSheets ?? LIMITS.maxSheets
  const maxCells = limits.maxCells ?? LIMITS.maxCells
  const maxEntries = limits.maxEntries ?? LIMITS.maxEntries
  try {
    const b = bytes
    const eocd = findEocd(b)
    if (eocd < 0) throw new Stop('not_xlsx')
    const entries = u16(b, eocd + 10)
    const cdSize = u32(b, eocd + 12)
    const cdOffset = u32(b, eocd + 16)
    // Multi-disk and zip64 archives are not spreadsheets Excel writes at this size.
    if (u16(b, eocd + 4) !== 0 || u16(b, eocd + 6) !== 0 || entries === 0xffff || cdOffset === 0xffffffff) throw new Stop('not_xlsx')
    if (entries > maxEntries || cdOffset + cdSize > eocd) throw new Stop('not_xlsx')

    let total = 0
    let sheets = 0
    let cells = 0
    let workbook = false
    const names = new Set<string>()
    const utf8 = new TextDecoder('utf-8')
    let p = cdOffset
    for (let i = 0; i < entries; i++) {
      if (p + 46 > cdOffset + cdSize || u32(b, p) !== SIG_CENTRAL) throw new Stop('not_xlsx')
      const flags = u16(b, p + 8)
      const method = u16(b, p + 10)
      const compSize = u32(b, p + 20)
      const nameLen = u16(b, p + 28)
      const extraLen = u16(b, p + 30)
      const commentLen = u16(b, p + 32)
      const localOff = u32(b, p + 42)
      const nameBytes = b.subarray(p + 46, p + 46 + nameLen)
      p += 46 + nameLen + extraLen + commentLen
      if (p > cdOffset + cdSize) throw new Stop('not_xlsx')
      if (flags & 1) throw new Stop('not_xlsx') // encrypted entry
      if (method !== 0 && method !== 8) throw new Stop('not_xlsx')

      // The local header this entry points at must agree with it.
      if (localOff + 30 > cdOffset || u32(b, localOff) !== SIG_LOCAL) throw new Stop('not_xlsx')
      const lNameLen = u16(b, localOff + 26)
      const lExtraLen = u16(b, localOff + 28)
      if (u16(b, localOff + 8) !== method || !sameBytes(b.subarray(localOff + 30, localOff + 30 + lNameLen), nameBytes)) throw new Stop('not_xlsx')
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const dataEnd = dataStart + compSize
      if (dataEnd > cdOffset) throw new Stop('not_xlsx')

      const raw = utf8.decode(nameBytes)
      const name = raw.startsWith('/') ? raw.slice(1) : raw
      if (names.has(name)) throw new Stop('not_xlsx')
      names.add(name)
      if (name.endsWith('/')) continue // a directory
      const isWorkbook = name === 'xl/workbook.xml'
      const isSheet = WORKSHEET_NAME.test(name)
      if (isWorkbook) workbook = true
      const dec = isWorkbook || isSheet ? new TextDecoder('latin1') : null
      let tail = ''
      const take = (chunk: Uint8Array) => {
        total += chunk.length
        if (total > maxUncompressed) throw new Stop('too_large_uncompressed')
        if (!dec) return
        const s = tail + dec.decode(chunk, { stream: true })
        if (isWorkbook) sheets += countFrom(s, SHEET_RE, tail.length)
        else cells += countFrom(s, CELL_RE, tail.length)
        tail = s.slice(-TAIL)
        if (cells > maxCells) throw new Stop('too_many_cells')
      }
      const data = b.subarray(dataStart, dataEnd)
      if (method === 0) {
        for (let k = 0; k < data.length; k += CHUNK) take(data.subarray(k, k + CHUNK))
      } else {
        const inf = new Inflate((chunk) => take(chunk))
        for (let k = 0; k < data.length; k += CHUNK) inf.push(data.subarray(k, Math.min(data.length, k + CHUNK)), k + CHUNK >= data.length)
        if (!data.length) inf.push(new Uint8Array(0), true)
      }
    }
    if (!workbook) return { ok: false, error: 'not_xlsx' }
    if (sheets > maxSheets) return { ok: false, error: 'too_many_sheets' }
    return { ok: true, sheets, cells }
  } catch (err) {
    return { ok: false, error: err instanceof Stop ? err.code : 'not_xlsx' }
  }
}
