import { Unzip, UnzipInflate } from 'fflate'
import { LIMITS } from '@/lib/sheets/model'

/**
 * Zip-bomb guard for an .xlsx, run BEFORE exceljs sees the bytes. Inflates
 * every entry in a streaming pass (16 KB of input at a time, never kept) and
 * stops as soon as the real uncompressed total passes the cap — the sizes a
 * zip declares can lie, the inflated bytes cannot. On the way it counts
 * sheets in xl/workbook.xml and cells in the worksheets, so the sheet and
 * cell caps hold before exceljs allocates anything.
 */

export type ZipScan =
  | { ok: true; sheets: number; cells: number }
  | { ok: false; error: 'not_xlsx' | 'too_large_uncompressed' | 'too_many_sheets' | 'too_many_cells' }

const CHUNK = 16 * 1024
const SHEET_RE = /<(?:\w{1,12}:)?sheet[\s/>]/g
const CELL_RE = /<(?:\w{1,12}:)?c[\s/>]/g
/** Longer than any match, so one split across chunks is still seen (and counted once). */
const TAIL = 24

/** Matches that end past `from` (those ending inside the carried tail were counted already). */
function countFrom(s: string, re: RegExp, from: number): number {
  let n = 0
  re.lastIndex = 0
  for (let m = re.exec(s); m; m = re.exec(s)) if (m.index + m[0].length > from) n++
  return n
}

export function scanXlsxZip(
  bytes: Uint8Array,
  limits: { maxUncompressed?: number; maxSheets?: number; maxCells?: number; maxEntries?: number } = {}
): ZipScan {
  const maxUncompressed = limits.maxUncompressed ?? LIMITS.maxUncompressed
  const maxSheets = limits.maxSheets ?? LIMITS.maxSheets
  const maxCells = limits.maxCells ?? LIMITS.maxCells
  const maxEntries = limits.maxEntries ?? LIMITS.maxEntries
  let total = 0
  let entries = 0
  let sheets = 0
  let cells = 0
  let workbook = false
  let error: Exclude<ZipScan, { ok: true }>['error'] | null = null

  const uz = new Unzip()
  uz.register(UnzipInflate)
  uz.onfile = (f) => {
    if (error) return
    if (++entries > maxEntries) {
      error = 'not_xlsx'
      return
    }
    const isWorkbook = f.name === 'xl/workbook.xml'
    const isSheet = /^xl\/worksheets\/[^/]+\.xml$/.test(f.name)
    if (isWorkbook) workbook = true
    const dec = isWorkbook || isSheet ? new TextDecoder('latin1') : null
    let tail = ''
    f.ondata = (err, chunk) => {
      if (error) return
      if (err) {
        error = 'not_xlsx'
        return
      }
      total += chunk.length
      if (total > maxUncompressed) {
        error = 'too_large_uncompressed'
        try {
          f.terminate()
        } catch {
          // already finished
        }
        return
      }
      if (!dec) return
      const s = tail + dec.decode(chunk, { stream: true })
      if (isWorkbook) sheets += countFrom(s, SHEET_RE, tail.length)
      else cells += countFrom(s, CELL_RE, tail.length)
      tail = s.slice(-TAIL)
      if (cells > maxCells) error = 'too_many_cells'
    }
    f.start()
  }

  try {
    for (let i = 0; i < bytes.length && !error; i += CHUNK) {
      const end = Math.min(bytes.length, i + CHUNK)
      uz.push(bytes.subarray(i, end), end === bytes.length)
    }
  } catch {
    return { ok: false, error: error ?? 'not_xlsx' }
  }
  if (error) return { ok: false, error }
  if (!workbook) return { ok: false, error: 'not_xlsx' }
  if (sheets > maxSheets) return { ok: false, error: 'too_many_sheets' }
  return { ok: true, sheets, cells }
}
