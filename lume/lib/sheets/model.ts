/**
 * Spreadsheets (pure; shared by the browser and the server). A parsed file
 * is a list of tables: every cell a string (dates ISO, formulas their cached
 * value, numbers at 15 significant digits), a detected header row, title
 * rows above it skipped, empty and merged-overflow columns dropped. The
 * parser itself (exceljs / the CSV reader) lives in lib/sheets/parse.ts.
 */

import { csvCell } from '@/lib/csv/cell'

/** Per attached file. */
export const MAX_SHEET_FILE_BYTES = 10 * 1024 * 1024
/** Spreadsheet files per message (the 5-image limit is separate). */
export const MAX_SHEET_FILES = 3

/** Zip-bomb and size guards (the parse refuses past any of these). */
export const LIMITS = {
  /** Total uncompressed bytes of the .xlsx archive. */
  maxUncompressed: 50 * 1024 * 1024,
  maxSheets: 20,
  maxCells: 500_000,
  /**
   * Columns per sheet. Wider sheets are refused (too_many_columns), never
   * cut: a stray cell far to the right would otherwise be densified into
   * every row (a 33 KB file took 1 GB).
   */
  maxColumns: 1000,
  /** Rows × columns of one sheet once dense, checked before densifying. */
  maxGridCells: 2_000_000,
  /** Characters of cell text across the whole file once parsed (shared-string fan-out). */
  maxChars: 50_000_000,
  /** Entries in the zip (an .xlsx has a few dozen). */
  maxEntries: 2000,
}

/** One cell's text is cut past this. */
export const CELL_MAX_CHARS = 5000

export type SheetFileKind = 'xlsx' | 'csv'

export interface ParsedSheet {
  name: string
  hidden: boolean
  header: string[]
  /** 1-based source row of the header; null when none was detected (columns are named by letter). */
  header_row: number | null
  rows: string[][]
  /** Columns dropped: empty in the header and every row (merged-cell overflow included). */
  dropped_columns: number
  /** Non-empty rows above the header (titles, notes) that were skipped. */
  skipped_rows: number
  /** Cells cut at CELL_MAX_CHARS. */
  truncated_cells: number
}

export interface ParsedWorkbook {
  kind: SheetFileKind
  sheets: ParsedSheet[]
  /** CSV only. */
  encoding?: 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin1'
  /** CSV only. */
  delimiter?: string
}

export type ParseError =
  | 'empty'
  | 'not_xlsx'
  | 'not_csv'
  | 'legacy_or_encrypted'
  | 'too_large_uncompressed'
  | 'too_many_sheets'
  | 'too_many_cells'
  | 'too_many_columns'
  | 'unreadable'

export type ParseResult = { ok: true; workbook: ParsedWorkbook } | { ok: false; error: ParseError }

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const SHEET_MIME: Record<SheetFileKind, string> = { xlsx: XLSX_MIME, csv: 'text/csv' }

/** Extensions the composer and the Import card route here (.xls only to say "save as .xlsx"). */
export function sheetExt(name: string): 'xlsx' | 'csv' | 'xls' | null {
  const m = /\.(xlsx|csv|xls)$/i.exec(name.trim())
  return m ? (m[1].toLowerCase() as 'xlsx' | 'csv' | 'xls') : null
}

/** A file the composer treats as a spreadsheet (by name, or by type when the name has no extension). */
export function isSheetFile(f: { name: string; type?: string }): boolean {
  if (sheetExt(f.name)) return true
  return /^(text\/csv|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/.test(f.type ?? '')
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x)

/**
 * What the bytes are: a zip (an .xlsx candidate), an OLE compound file (a
 * legacy .xls, or a password-protected .xlsx — Excel wraps those in OLE),
 * some other binary, or text (a CSV candidate). Never the client's claim.
 */
export function sniffSpreadsheet(b: Uint8Array): 'zip' | 'ole' | 'binary' | 'text' {
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'zip'
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'
  if (startsWith(b, [0xef, 0xbb, 0xbf]) || startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) return 'text'
  const binary = [
    [0x25, 0x50, 0x44, 0x46], // %PDF
    [0x89, 0x50, 0x4e, 0x47], // PNG
    [0xff, 0xd8, 0xff], // JPEG
    [0x47, 0x49, 0x46, 0x38], // GIF
    [0x1f, 0x8b], // gzip
    [0x37, 0x7a, 0xbc, 0xaf], // 7z
    [0x52, 0x61, 0x72, 0x21], // Rar
  ]
  if (binary.some((sig) => startsWith(b, sig))) return 'binary'
  if (b.subarray(0, 8192).includes(0)) return 'binary'
  return 'text'
}

const NUMERIC = /^[-+(]?[$€£]?\s*[\d\s.,]+%?\)?$/
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:]+)?$/
const textLike = (v: string) => v !== '' && !NUMERIC.test(v) && !DATE.test(v) && v !== 'TRUE' && v !== 'FALSE'

/** Rows looked at when hunting for the header. */
const HEADER_SCAN = 20

/**
 * The header row: among the first non-empty rows, the first one that is at
 * least half as wide as the widest of them and mostly text (not numbers or
 * dates). Title rows ("Leads Q3", a lone note) above it
 * are skipped. `index` is into `grid`; -1 when no row qualifies (all numbers).
 */
export function detectHeader(grid: readonly (readonly string[])[]): { index: number; detected: boolean } {
  const candidates: number[] = []
  for (let i = 0; i < grid.length && candidates.length < HEADER_SCAN; i++) if (grid[i].some((v) => v !== '')) candidates.push(i)
  if (!candidates.length) return { index: -1, detected: false }
  const filled = (i: number) => grid[i].filter((v) => v !== '')
  const widest = Math.max(...candidates.map((i) => filled(i).length))
  for (const i of candidates) {
    const cells = filled(i)
    if (cells.length < Math.max(1, Math.ceil(widest / 2))) continue
    const text = cells.filter(textLike).length
    if (text < Math.ceil(cells.length * 0.8)) continue
    return { index: i, detected: true }
  }
  return { index: -1, detected: false }
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(i: number): string {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/**
 * A raw grid (row-major, '' for empty, ragged) → one table: header found,
 * blank rows and title rows skipped, columns empty everywhere dropped,
 * blank header cells named "Column <letter>", duplicates suffixed " (2)".
 * `rowNumbers` are the grid rows' 1-based source rows when the grid is
 * compact (only the rows a sheet actually has); default index + 1. Callers
 * cap width and width × rows first (LIMITS.maxColumns / maxGridCells).
 */
export function buildSheet(name: string, hidden: boolean, raw: string[][], truncated_cells = 0, rowNumbers?: readonly number[]): ParsedSheet {
  const grid = raw.map((r) => Array.from(r, (v) => (v ?? '').trim()))
  const { index, detected } = detectHeader(grid)
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0)
  const headerCells = detected ? grid[index] : []
  const start = detected ? index + 1 : 0
  const body = grid.slice(start).filter((r) => r.some((v) => v !== ''))
  const skipped = detected ? grid.slice(0, index).filter((r) => r.some((v) => v !== '')).length : 0
  const keep: number[] = []
  for (let c = 0; c < width; c++) {
    if ((headerCells[c] ?? '') !== '' || body.some((r) => (r[c] ?? '') !== '')) keep.push(c)
  }
  const seen = new Map<string, number>()
  const header = keep.map((c) => {
    const base = (detected ? headerCells[c] : '') || `Column ${columnLetter(c)}`
    const k = base.toLowerCase()
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return n > 1 ? `${base} (${n})` : base
  })
  return {
    name,
    hidden,
    header,
    header_row: detected ? (rowNumbers?.[index] ?? index + 1) : null,
    rows: body.map((r) => keep.map((c) => r[c] ?? '')),
    dropped_columns: width - keep.length,
    skipped_rows: skipped,
    truncated_cells,
  }
}

// ---------------------------------------------------------------------------
// CSV writing (what the agent reads, and what goes to the ingest gate)

/** One CSV field: quoted when it holds a comma, quote or newline, or edge spaces. */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v
}

export const csvLine = (cells: readonly string[]) => cells.map(csvField).join(',')

/**
 * Header + rows → CSV for the ingest gate, through the shared formula-safe
 * cell writer (lib/csv/cell.ts): line breaks inside a cell become spaces (the
 * pipeline reads files line by line), a leading = + - @ is prefixed with ',
 * `\n` endings, trailing newline, no BOM.
 */
export function sheetToIngestCsv(sheet: Pick<ParsedSheet, 'header' | 'rows'>): string {
  const line = (cells: readonly string[]) => cells.map(csvCell).join(',')
  return [line(sheet.header), ...sheet.rows.map(line)].join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// What the agent sees

/** One sheet's counts, as stored on the file row and the message. */
export interface SheetMeta {
  name: string
  rows: number
  cols: number
  hidden?: boolean
}

export const sheetMeta = (s: ParsedSheet): SheetMeta => ({ name: s.name, rows: s.rows.length, cols: s.header.length, ...(s.hidden ? { hidden: true } : {}) })

/** Rows shown in the summary per sheet. */
export const PREVIEW_ROWS = 50
/** The summary text per file. */
export const SUMMARY_MAX_CHARS = 20_000

const fmt = new Intl.NumberFormat('en-US')
const plural = (n: number, w: string) => `${fmt.format(n)} ${w}${n === 1 ? '' : 's'}`

export function formatFileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** A display name: base name only, no control characters, ≤ 120 chars. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (clean || 'spreadsheet').slice(0, 120)
}

/**
 * The text the agent gets for one file in the turn it was attached: the
 * file, each sheet's counts (hidden ones marked), then per sheet the header
 * and the first PREVIEW_ROWS rows as CSV, within SUMMARY_MAX_CHARS. What was
 * cut is said, with the read_attachment call that pages past it.
 */
type FileHead = { id: string; name: string; kind: SheetFileKind; size_bytes: number }

/** The file line, the CSV encoding line and one line per sheet (counts and notes). */
function summaryHead(file: FileHead, wb: ParsedWorkbook): string[] {
  const head: string[] = [
    `File: ${file.name} (${file.kind}, ${formatFileSize(file.size_bytes)}) · file_id ${file.id}`,
    ...(wb.kind === 'csv' ? [`CSV read as ${wb.encoding ?? 'utf-8'}, delimiter ${JSON.stringify(wb.delimiter ?? ',')}.`] : []),
    `${plural(wb.sheets.length, 'sheet')}:`,
  ]
  for (const s of wb.sheets) {
    const notes = [
      s.hidden ? 'hidden' : null,
      s.header_row ? `header on row ${s.header_row}` : 'no header row found, columns named by letter',
      s.skipped_rows ? `${plural(s.skipped_rows, 'title row')} above it skipped` : null,
      s.dropped_columns ? `${plural(s.dropped_columns, 'empty column')} dropped` : null,
      s.truncated_cells ? `${plural(s.truncated_cells, 'long cell')} cut at ${fmt.format(CELL_MAX_CHARS)} chars` : null,
    ].filter(Boolean)
    head.push(`- "${s.name}": ${plural(s.rows.length, 'row')} × ${plural(s.header.length, 'column')} (${notes.join('; ')})`)
  }
  return head
}

/** The replayed form (BRIEF_MAX_CHARS): the head lines and each sheet's header, no rows. */
export const BRIEF_MAX_CHARS = 4000

export function fileBrief(file: FileHead, wb: ParsedWorkbook, max = BRIEF_MAX_CHARS): string {
  const lines = summaryHead(file, wb)
  for (const s of wb.sheets) if (s.header.length) lines.push(`Header of "${s.name}": ${csvLine(s.header.map(clipCell))}`)
  lines.push(`(Rows are not repeated here: read_attachment(file_id: "${file.id}", sheet, offset) pages through them.)`)
  const text = lines.join('\n')
  return text.length > max ? `${text.slice(0, max - 40)}\n… [brief cut for length]` : text
}

/** A cell as the agent reads it: cut past READ_CELL_MAX_CHARS. */
export const READ_CELL_MAX_CHARS = 500
export const clipCell = (v: string) => (v.length > READ_CELL_MAX_CHARS ? `${v.slice(0, READ_CELL_MAX_CHARS)}…[+${v.length - READ_CELL_MAX_CHARS} chars]` : v)

export function fileSummary(file: FileHead, wb: ParsedWorkbook, max = SUMMARY_MAX_CHARS): string {
  const head = summaryHead(file, wb)
  const out = [head.join('\n')]
  let left = max - out[0].length
  const unshown: string[] = []
  for (const s of wb.sheets) {
    if (!s.header.length) continue
    const title = `\n\n--- Sheet "${s.name}": header + first rows as CSV ---\n`
    const headerLine = csvLine(s.header)
    if (left < title.length + headerLine.length + 200) {
      unshown.push(s.name)
      continue
    }
    let block = title + headerLine
    let shown = 0
    for (const r of s.rows.slice(0, PREVIEW_ROWS)) {
      const line = `\n${csvLine(r)}`
      if (block.length + line.length > left - 160) break
      block += line
      shown++
    }
    const rest = s.rows.length - shown
    if (rest > 0) block += `\n[${plural(rest, 'more row')} not shown — read_attachment(file_id: "${file.id}", sheet: ${JSON.stringify(s.name)}, offset: ${shown})]`
    out.push(block)
    left -= block.length
  }
  if (unshown.length) out.push(`\n\n[Not previewed for length: ${unshown.map((n) => JSON.stringify(n)).join(', ')} — use read_attachment.]`)
  return out.join('').slice(0, max)
}

/** read_attachment: rows per call and characters per answer. */
export const READ_MAX_ROWS = 500
export const READ_DEFAULT_ROWS = 100
export const READ_MAX_CHARS = 20_000

/**
 * One page of a sheet as CSV (header first), from `offset` (0 = first data
 * row), at most `limit` rows and READ_MAX_CHARS characters; `next_offset`
 * when there is more.
 */
export function readWindow(sheet: Pick<ParsedSheet, 'header' | 'rows'>, offset: number, limit = READ_DEFAULT_ROWS, maxChars = READ_MAX_CHARS) {
  const start = Math.max(0, Math.min(Math.floor(offset), sheet.rows.length))
  const cap = Math.max(1, Math.min(Math.floor(limit), READ_MAX_ROWS))
  let csv = csvLine(sheet.header)
  let i = start
  for (; i < sheet.rows.length && i < start + cap; i++) {
    const line = `\n${csvLine(sheet.rows[i])}`
    if (i > start && csv.length + line.length > maxChars) break
    csv += line
  }
  return { offset: start, returned: i - start, total_rows: sheet.rows.length, next_offset: i < sheet.rows.length ? i : null, csv }
}

/** A sheet by name (case-insensitive) or 1-based index; default the first visible sheet with rows. */
export function pickSheet<T extends Pick<ParsedSheet, 'name' | 'hidden' | 'rows'>>(sheets: readonly T[], which?: string | number | null): T | null {
  if (which === undefined || which === null || which === '') return sheets.find((s) => !s.hidden && s.rows.length) ?? sheets.find((s) => s.rows.length) ?? sheets[0] ?? null
  if (typeof which === 'number') return sheets[which - 1] ?? null
  const exact = sheets.find((s) => s.name === which)
  if (exact) return exact
  const low = which.trim().toLowerCase()
  return sheets.find((s) => s.name.toLowerCase() === low) ?? (/^\d+$/.test(low) ? (sheets[Number(low) - 1] ?? null) : null)
}

/** User-facing text for an attach / upload failure (after the file name). */
export const SHEET_ERRORS: Record<string, string> = {
  xls: 'is an old .xls workbook — open it in Excel or Numbers and save as .xlsx',
  legacy_or_encrypted: 'is an old .xls or a password-protected workbook — save it as .xlsx without a password',
  too_large: `is over the ${formatFileSize(MAX_SHEET_FILE_BYTES)} limit`,
  too_large_uncompressed: 'expands to more than 50 MB of data — split it into smaller files',
  too_many_sheets: `has more than ${LIMITS.maxSheets} sheets`,
  too_many_cells: `has more than ${fmt.format(LIMITS.maxCells)} cells — split it into smaller files`,
  too_many_columns: `has a sheet wider than ${fmt.format(LIMITS.maxColumns)} columns — delete the stray far-right cells or split it`,
  not_xlsx: "doesn't read as an .xlsx workbook",
  not_csv: "doesn't read as a CSV (text) file",
  unsupported_media_type: 'is not an .xlsx or .csv file',
  empty: 'has no data',
  unreadable: 'could not be read',
  too_many: `Up to ${MAX_SHEET_FILES} spreadsheets per message`,
  upload: 'could not be uploaded',
  invalid_ticket: 'upload expired — attach it again',
  upload_missing: 'did not arrive — attach it again',
}
