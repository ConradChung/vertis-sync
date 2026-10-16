/**
 * CSV helpers for Lume's intakes. Pure (client and server).
 *
 * The email-column detection, header normalisation, dropped columns, row
 * parser and the header/row-count helpers are copied from
 * `supabase/functions/telegram-inbox/index.ts` (edge functions share no code
 * with the Next.js apps). Keep them byte-for-byte in behaviour: the owner
 * prompt Lume sends must name the same column telegram-inbox will use when
 * the ingest is approved. `tests/import/csv.test.ts` pins the parity cases.
 */

const TIER1_NAMES = new Set(['email', 'work_email', 'business_email'])
const PERSONAL_SUBSTRINGS = ['personal']

/** Bulk Apollo columns telegram-inbox drops at approval (not used for detection). */
export const DROPPED_COLUMNS = new Set(['keywords', 'technologies'])

export function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/\s+/g, '_')
}

export function keptColumnIndexes(headers: string[]): number[] {
  const keep: number[] = []
  for (let i = 0; i < headers.length; i++) {
    if (!DROPPED_COLUMNS.has(normalizeHeader(headers[i]))) keep.push(i)
  }
  return keep
}

export type EmailDetection = { column: string } | { ambiguous: string[] } | { error: string }

// Signature spelled out as upstream writes it (tests/import/parity.test.ts compares the source).
export function detectEmailColumn(headers: string[]): { column: string } | { ambiguous: string[] } | { error: string } {
  const normalized = headers.map(normalizeHeader)
  const tier1: string[] = []
  const tier3: string[] = []
  for (let i = 0; i < headers.length; i++) {
    const norm = normalized[i]
    const isPersonal = PERSONAL_SUBSTRINGS.some((p) => norm.includes(p))
    if (TIER1_NAMES.has(norm)) tier1.push(headers[i])
    else if (!isPersonal && (norm.includes('email') || norm.includes('mail'))) tier3.push(headers[i])
  }
  if (tier1.length === 1) return { column: tier1[0] }
  if (tier1.length > 1) return { ambiguous: tier1 }
  if (tier3.length === 1) return { column: tier3[0] }
  if (tier3.length > 1) return { ambiguous: tier3 }
  return { error: 'No email column found in CSV' }
}

/** The column the owner prompt names, or `null` (ambiguous / none → Deny only). */
export function detectedEmailColumn(headers: string[]): string | null {
  const d = detectEmailColumn(headers)
  return 'column' in d ? d.column : null
}

/** One CSV line → cells (quoted commas, doubled quotes). Same output as telegram-inbox's. */
export function parseCSVRow(row: string): string[] {
  const out: string[] = []
  let i = 0
  while (i <= row.length) {
    if (row.charCodeAt(i) === 34 /* " */) {
      let val = ''
      i++
      let start = i
      while (i < row.length) {
        if (row.charCodeAt(i) === 34) {
          if (row.charCodeAt(i + 1) === 34) {
            val += row.slice(start, i) + '"'
            i += 2
            start = i
            continue
          }
          break
        }
        i++
      }
      val += row.slice(start, i)
      out.push(val)
      i++ // closing quote
      if (row.charCodeAt(i) === 44 /* , */) i++
      else if (i >= row.length) break
    } else {
      const next = row.indexOf(',', i)
      if (next === -1) {
        out.push(row.slice(i))
        break
      }
      out.push(row.slice(i, next))
      i = next + 1
    }
  }
  return out
}

/** Non-empty lines, `\r\n` or `\n` (telegram-inbox's `iterLines`). */
export function* iterLines(text: string): Generator<string> {
  let start = 0
  while (start < text.length) {
    let nl = text.indexOf('\n', start)
    if (nl === -1) nl = text.length
    let end = nl
    if (end > start && text.charCodeAt(end - 1) === 13 /* \r */) end--
    if (end > start) yield text.slice(start, end)
    start = nl + 1
  }
}

/** The first line, decoded, without its line ending. */
export function headerFromBytes(bytes: Uint8Array): string {
  let end = bytes.indexOf(10)
  if (end === -1) end = bytes.length
  let sliceEnd = end
  if (sliceEnd > 0 && bytes[sliceEnd - 1] === 13) sliceEnd--
  return new TextDecoder().decode(bytes.subarray(0, sliceEnd))
}

/** Newline count minus the header — exactly what telegram-inbox stores as `row_count`. */
export function countDataRows(bytes: Uint8Array): number {
  let newlines = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) newlines++
  const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === 10
  const totalLines = endsWithNewline ? newlines : newlines + 1
  return Math.max(0, totalLines - 1)
}

/**
 * Header sniff for an uploaded file: text (no NUL bytes in the first 4 KB),
 * a first line with at least one non-empty column name. Returns the parsed
 * header or `null`.
 */
export function sniffCsvHeader(bytes: Uint8Array): string[] | null {
  if (bytes.length === 0) return null
  const head = bytes.subarray(0, 4096)
  if (head.includes(0)) return null
  let line = headerFromBytes(bytes)
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1) // BOM
  const headers = parseCSVRow(line)
  return headers.some((h) => h.trim() !== '') ? headers : null
}

// ---------------------------------------------------------------------------
// Writer

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  // The pipeline reads files line by line (telegram-inbox `iterLines`, and
  // `countDataRows` counts newline bytes), so a newline inside a quoted cell
  // would split the row. Flatten line breaks to spaces.
  const flat = s.replace(/\r\n|\r|\n/g, ' ')
  return /[",]/.test(flat) || flat !== flat.trim() ? `"${flat.replace(/"/g, '""')}"` : flat
}

/**
 * Items → CSV text. Columns are the union of keys in first-seen order;
 * nested objects and arrays are JSON-stringified; null/undefined are empty.
 * `\n` line endings, trailing newline, no BOM.
 */
export function toCsv(items: readonly Record<string, unknown>[]): string {
  const columns: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    for (const k of Object.keys(item)) {
      if (!seen.has(k)) {
        seen.add(k)
        columns.push(k)
      }
    }
  }
  if (columns.length === 0) return ''
  const lines = [columns.map(cell).join(',')]
  for (const item of items) lines.push(columns.map((c) => cell(item[c])).join(','))
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Sample (orders detail)

export interface CsvSample {
  headers: string[]
  rows: string[][]
}

/** Header + the first `n` data rows of CSV text (a partial last line is dropped when `truncated`). */
export function sampleCsv(text: string, n = 5, truncated = false): CsvSample {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  // A cut-off download ends mid-line; never show that half row.
  const usable = truncated && !body.endsWith('\n') ? body.slice(0, body.lastIndexOf('\n') + 1) : body
  const it = iterLines(usable)
  const first = it.next()
  if (first.done) return { headers: [], rows: [] }
  const headers = parseCSVRow(first.value)
  const rows: string[][] = []
  for (const line of it) {
    if (rows.length >= n) break
    rows.push(parseCSVRow(line))
  }
  return { headers, rows }
}

/** Upload / generated-file ceiling (the same 20 MB Telegram imposes on dropped files). */
export const MAX_CSV_BYTES = 20 * 1024 * 1024
