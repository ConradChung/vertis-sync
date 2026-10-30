import ExcelJS from 'exceljs'
import { CsvLimitError, decodeCsv, detectDelimiter, parseDelimited } from '@/lib/sheets/csv'
import { buildSheet, CELL_MAX_CHARS, LIMITS, sniffSpreadsheet, type ParsedSheet, type ParseResult, type SheetFileKind } from '@/lib/sheets/model'
import { scanXlsxZip } from '@/lib/sheets/zipGuard'

/**
 * Parse an attached spreadsheet (server side; exceljs 4.4 for .xlsx, our own
 * reader for CSV). `kind` comes from the magic bytes (the route sniffs them),
 * never from the name. Every sheet becomes a table (lib/sheets/model.ts
 * buildSheet). An .xlsx goes through the zip-bomb guard first
 * (lib/sheets/zipGuard.ts), then exceljs; cells are counted again while
 * reading, and the total cell text is capped so shared strings cannot fan
 * out into gigabytes. Never throws.
 */

export type Limits = Partial<typeof LIMITS>

class CapError extends Error {
  constructor(readonly code: 'too_many_cells' | 'too_many_columns' | 'too_large_uncompressed') {
    super(code)
  }
}

/** Running totals across the file. */
interface Budget {
  cells: number
  chars: number
  maxCells: number
  maxChars: number
}

function charge(b: Budget, text: string) {
  if (++b.cells > b.maxCells) throw new CapError('too_many_cells')
  b.chars += text.length
  if (b.chars > b.maxChars) throw new CapError('too_large_uncompressed')
}

export async function parseSpreadsheet(bytes: Uint8Array, kind: SheetFileKind, limits: Limits = {}): Promise<ParseResult> {
  const L = { ...LIMITS, ...limits }
  const budget: Budget = { cells: 0, chars: 0, maxCells: L.maxCells, maxChars: L.maxChars }
  try {
    const sheets = kind === 'xlsx' ? await readXlsx(bytes, L, budget) : null
    if (sheets && !sheets.ok) return sheets
    if (kind === 'xlsx') {
      const list = (sheets as { ok: true; sheets: ParsedSheet[] }).sheets
      return list.some((s) => s.rows.length || s.header.length) ? { ok: true, workbook: { kind, sheets: list } } : { ok: false, error: 'empty' }
    }
    if (sniffSpreadsheet(bytes) !== 'text') return { ok: false, error: 'not_csv' }
    const decoded = decodeCsv(bytes)
    if (!decoded) return { ok: false, error: 'not_csv' }
    const delimiter = detectDelimiter(decoded.text, L.maxColumns)
    let truncated = 0
    let parsedRows: string[][]
    try {
      parsedRows = parseDelimited(decoded.text, delimiter, Infinity, { maxCols: L.maxColumns, maxCells: L.maxCells })
    } catch (err) {
      if (err instanceof CsvLimitError) return { ok: false, error: err.code }
      throw err
    }
    checkGrid(parsedRows.length, parsedRows.reduce((w, r) => Math.max(w, r.length), 0), L)
    const grid = parsedRows.map((row) =>
      row.map((v) => {
        const cut = v.length > CELL_MAX_CHARS ? (truncated++, v.slice(0, CELL_MAX_CHARS)) : v
        charge(budget, cut)
        return cut
      })
    )
    const sheet = buildSheet('Sheet1', false, grid, truncated)
    if (!sheet.header.length) return { ok: false, error: 'empty' }
    return { ok: true, workbook: { kind, sheets: [sheet], encoding: decoded.encoding, delimiter } }
  } catch (err) {
    if (err instanceof CapError) return { ok: false, error: err.code }
    return { ok: false, error: 'unreadable' }
  }
}

async function readXlsx(bytes: Uint8Array, L: typeof LIMITS, budget: Budget): Promise<{ ok: true; sheets: ParsedSheet[] } | Extract<ParseResult, { ok: false }>> {
  const sniff = sniffSpreadsheet(bytes)
  if (sniff === 'ole') return { ok: false, error: 'legacy_or_encrypted' }
  if (sniff !== 'zip') return { ok: false, error: 'not_xlsx' }
  const scan = scanXlsxZip(bytes, { maxUncompressed: L.maxUncompressed, maxSheets: L.maxSheets, maxCells: L.maxCells, maxEntries: L.maxEntries })
  if (!scan.ok) return scan

  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  if (wb.worksheets.length > L.maxSheets) return { ok: false, error: 'too_many_sheets' }
  const date1904 = !!(wb.properties as { date1904?: boolean } | undefined)?.date1904
  const sheets: ParsedSheet[] = []
  for (const ws of wb.worksheets) {
    // Compact: only the rows the sheet has, with their source numbers (a cell
    // on row 500,000 must not allocate the 499,999 rows above it).
    const grid: string[][] = []
    const rowNumbers: number[] = []
    let width = 0
    let truncated = 0
    let uncached = 0
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      const out: string[] = []
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        // Before anything is stored: a cell past the width cap refuses the sheet.
        if (c > L.maxColumns) throw new CapError('too_many_columns')
        // A merged range keeps its value in the top-left cell only.
        if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
          out[c - 1] = ''
          return
        }
        const val = cellValue(cell, date1904)
        if (val.uncached) uncached++
        let text = val.text
        if (text.length > CELL_MAX_CHARS) {
          text = text.slice(0, CELL_MAX_CHARS)
          truncated++
        }
        charge(budget, text)
        out[c - 1] = text
      })
      width = Math.max(width, out.length)
      checkGrid(grid.length + 1, width, L)
      grid.push(Array.from(out, (v) => v ?? ''))
      rowNumbers.push(r)
    })
    const built = buildSheet(ws.name, ws.state !== 'visible', grid, truncated, rowNumbers)
    sheets.push(uncached ? { ...built, uncached_formulas: uncached } : built)
  }
  return { ok: true, sheets }
}

/** Refuse a sheet whose dense size (rows × widest row) would pass the caps, before it is built. */
function checkGrid(rows: number, width: number, L: typeof LIMITS) {
  if (width > L.maxColumns) throw new CapError('too_many_columns')
  if (rows * width > L.maxGridCells) throw new CapError('too_many_cells')
}

// ---------------------------------------------------------------------------
// Cell values

const DATE_FMT = /(^|[^\\"])[dmyhs]/i

/** A number format that displays a date or time (ignoring quoted text and [colour] tags). */
export function isDateFormat(fmt: string | undefined): boolean {
  if (!fmt || fmt === 'General') return false
  const bare = fmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '')
  return DATE_FMT.test(bare)
}

/** A number format that shows only a time of day or a duration (h / s, no d / y). */
export function isTimeFormat(fmt: string | undefined): boolean {
  if (!fmt || fmt === 'General') return false
  const bare = fmt.replace(/"[^"]*"/g, '').replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '')
  return /[hs]/i.test(bare) && !/[dy]/i.test(bare)
}

/** `HH:MM:SS` of a Date (UTC, rounded to the second). */
const timeText = (d: Date) => new Date(Math.round(d.getTime() / 1000) * 1000).toISOString().slice(11, 19)

/**
 * A date-time cell as text: a time-only cell (a time format on Excel's day 0,
 * or any value before 1900, which can only be day 0) is `HH:MM:SS`; else ISO.
 */
function dateText(d: Date, numFmt: string | undefined): string {
  if (Number.isNaN(d.getTime())) return ''
  if (d.getUTCFullYear() < 1900 || (isTimeFormat(numFmt) && d.getTime() < Date.UTC(1904, 0, 2))) return timeText(d)
  return isoDate(d)
}

/** Excel serial → Date (UTC), 1900 system (with its 1900-02-29 bug) or 1904. */
export function serialToDate(serial: number, date1904 = false): Date {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  return new Date(base + Math.round(serial * 86_400_000))
}

/** `YYYY-MM-DD` for a whole day, else `YYYY-MM-DDTHH:mm:ss` (UTC, as Excel stores no zone). */
export function isoDate(d: Date): string {
  const t = new Date(Math.round(d.getTime() / 1000) * 1000)
  if (Number.isNaN(t.getTime())) return ''
  const iso = t.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19)
}

/** Excel shows 15 significant digits; 0.1 + 0.2 reads 0.3. */
const numText = (n: number) => (Number.isFinite(n) ? String(Number(n.toPrecision(15))) : '')

/** An exceljs cell, or what a test passes: the value, its number format, and (formula cells) the formula text. */
type CellLike = { value: unknown; numFmt?: string; formula?: string }

function valueText(v: unknown, numFmt: string | undefined, date1904: boolean): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return dateText(v, numFmt)
  if (typeof v === 'number') return isDateFormat(numFmt) ? dateText(serialToDate(v, date1904), numFmt) : numText(v)
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as { text?: unknown }[]).map((t) => (typeof t.text === 'string' ? t.text : '')).join('')
    // Formulas: the value Excel cached when the file was saved (no recalculation).
    if ('formula' in o || 'sharedFormula' in o) return valueText(o.result, numFmt, date1904)
    if (typeof o.error === 'string') return o.error
    if ('hyperlink' in o || 'text' in o) {
      const t = valueText(o.text, numFmt, date1904)
      return t || (typeof o.hyperlink === 'string' ? o.hyperlink : '')
    }
  }
  return ''
}

/**
 * One cell as text, and whether it is a formula Excel saved no value for
 * (never recalculated here): that one reads as its formula, `=A2*2`, so the
 * data is not silently blank, and the sheet notes how many there were. A
 * shared formula's own text comes from exceljs's `cell.formula`.
 */
export function cellValue(cell: CellLike, date1904 = false): { text: string; uncached: boolean } {
  const v = cell.value
  if (v && typeof v === 'object' && !(v instanceof Date) && ('formula' in v || 'sharedFormula' in v)) {
    const o = v as Record<string, unknown>
    if (o.result === undefined || o.result === null) {
      const f = [cell.formula, o.formula].find((x): x is string => typeof x === 'string' && x.length > 0)
      return { text: f ? `=${f}` : '', uncached: true }
    }
  }
  return { text: valueText(v, cell.numFmt, date1904), uncached: false }
}

export const cellText = (cell: CellLike, date1904 = false) => cellValue(cell, date1904).text
