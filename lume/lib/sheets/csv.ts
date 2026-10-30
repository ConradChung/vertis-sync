/**
 * CSV reading for attachments: encoding (UTF-8 with or without BOM, UTF-16
 * by BOM, else latin1), delimiter (, ; tab |) and an RFC 4180 parser
 * (quoted delimiters and newlines, "" escapes, \n / \r\n / \r endings).
 * Pure. The pipeline's own line-based reader is lib/import/csv.ts; this one
 * is only for files the owner attaches to the agent chat.
 */

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin1'

/** Text and the encoding it was read as; null when it is binary (NUL bytes). */
export function decodeCsv(b: Uint8Array): { text: string; encoding: CsvEncoding } | null {
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' }
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'utf-16be' }
  const body = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b
  if (body.includes(0)) return null
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' }
  } catch {
    // Not UTF-8 (Excel on Windows saves "CSV" in the ANSI code page).
    return { text: new TextDecoder('latin1').decode(body), encoding: 'latin1' }
  }
}

/** Rows of `text` split on `delim`; stops after `maxRows` rows when given. A trailing empty line is not a row. */
export function parseDelimited(text: string, delim: string, maxRows = Infinity): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = text.length
  const endRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
  }
  while (i < n && rows.length < maxRows) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') {
      quoted = true
      i++
    } else if (c === delim) {
      row.push(field)
      field = ''
      i++
    } else if (c === '\n' || c === '\r') {
      endRow()
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else {
      field += c
      i++
    }
  }
  if (rows.length < maxRows && (field !== '' || row.length)) endRow()
  return rows
}

const CANDIDATES = [',', ';', '\t', '|']

/**
 * The delimiter whose split gives the most rows with the same (> 1) number
 * of fields over the first 50 rows; ties go to the earlier candidate, and a
 * one-column file is ','.
 */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024)
  let best = ','
  let bestScore = 0
  for (const d of CANDIDATES) {
    const counts = parseDelimited(sample, d, 50).map((r) => r.length)
    const freq = new Map<number, number>()
    for (const c of counts) if (c > 1) freq.set(c, (freq.get(c) ?? 0) + 1)
    const score = Math.max(0, ...freq.values())
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}
