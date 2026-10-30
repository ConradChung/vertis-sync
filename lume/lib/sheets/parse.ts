import ExcelJS from 'exceljs'
import { decodeCsv, detectDelimiter, parseDelimited } from '@/lib/sheets/csv'
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
  constructor(readonly code: 'too_many_cells' | 'too_large_uncompressed') {
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
    const delimiter = detectDelimiter(decoded.text)
    let truncated = 0
    const grid = parseDelimited(decoded.text, delimiter).map((row) =>
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
    const grid: string[][] = []
    let truncated = 0
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      const out: string[] = []
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        // A merged range keeps its value in the top-left cell only.
        if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
          out[c - 1] = ''
          return
        }
        let text = cellText(cell, date1904)
        if (text.length > CELL_MAX_CHARS) {
          text = text.slice(0, CELL_MAX_CHARS)
          truncated++
        }
        charge(budget, text)
        out[c - 1] = text
      })
      grid[r - 1] = Array.from(out, (v) => v ?? '')
    })
    sheets.push(buildSheet(ws.name, ws.state !== 'visible', Array.from(grid, (r) => r ?? []), truncated))
  }
  return { ok: true, sheets }
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

type CellLike = { value: unknown; numFmt?: string }

function valueText(v: unknown, numFmt: string | undefined, date1904: boolean): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return isoDate(v)
  if (typeof v === 'number') return isDateFormat(numFmt) ? isoDate(serialToDate(v, date1904)) : numText(v)
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

export const cellText = (cell: CellLike, date1904 = false) => valueText(cell.value, cell.numFmt, date1904)
