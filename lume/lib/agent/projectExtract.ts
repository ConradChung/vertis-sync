import { CSV_MAX_ROWS, MAX_TEXT_CHARS, type FileType } from '@/lib/agent/projectModel'
import { csvLine, type ParsedWorkbook } from '@/lib/sheets/model'
import { parseSpreadsheet } from '@/lib/sheets/parse'

/**
 * Text extraction for project files, run once at upload:
 *  - CSV: header plus the first CSV_MAX_ROWS rows (quote-aware, so a quoted
 *    newline stays inside its row); line endings become \n.
 *  - PDF: the text layer (unpdf, a serverless build of pdf.js), page by
 *    page: at most PDF_MAX_PAGES pages, stopping past the character cap, all
 *    within PDF_TIMEOUT_MS (a timeout is "not readable").
 *  - XLSX: parsed like a chat attachment (lib/sheets/parse.ts: zip-bomb,
 *    sheet and cell caps; header detected, dates ISO, formulas their cached
 *    values), then every sheet as CSV under a `## Sheet "<name>"` line, so
 *    read_project_file pages through it. A file the parser refuses is not readable.
 *  - MD / TXT / JSON: as-is.
 *  - Images: none (listed by name only).
 * Everything is capped at MAX_TEXT_CHARS. A file that yields no text (binary,
 * a scanned PDF, a parse error) is `readable: false`: still stored, shown as
 * "not readable". Never throws.
 */

export interface Extracted {
  text: string | null
  readable: boolean
  truncated: boolean
}

const UNREADABLE: Extracted = { text: null, readable: false, truncated: false }

function decode(bytes: Uint8Array): string | null {
  // NUL bytes: binary, not text.
  if (bytes.includes(0)) return null
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
}

function capped(text: string, truncated = false): Extracted {
  if (!text.trim()) return UNREADABLE
  if (text.length > MAX_TEXT_CHARS) return { text: text.slice(0, MAX_TEXT_CHARS), readable: true, truncated: true }
  return { text, readable: true, truncated }
}

/**
 * The header plus up to `maxRows` data rows; `more` when rows were left out.
 * Quote-aware (a quoted newline stays in its field, "" is an escaped quote);
 * \n, \r\n and a lone \r all end a row; blank lines are not rows.
 */
export function csvHead(text: string, maxRows = CSV_MAX_ROWS): { text: string; more: boolean } {
  const rows: string[] = []
  let cur = ''
  let quoted = false
  const end = () => {
    if (cur.length) rows.push(cur)
    cur = ''
  }
  for (let i = 0; i < text.length && rows.length <= maxRows + 1; i++) {
    const c = text[i]
    if (c === '"') quoted = !quoted
    if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++
      end()
      continue
    }
    cur += c
  }
  if (rows.length <= maxRows + 1) end()
  return { text: rows.slice(0, maxRows + 1).join('\n'), more: rows.length > maxRows + 1 }
}

/** Each sheet as CSV under a heading with its counts, stopping once past the character cap. */
export function workbookText(wb: ParsedWorkbook, max = MAX_TEXT_CHARS): string {
  const parts: string[] = []
  let len = 0
  for (const s of wb.sheets) {
    const head = `## Sheet "${s.name}" (${s.rows.length} rows × ${s.header.length} columns${s.hidden ? ', hidden' : ''})`
    const lines = [head, ...(s.header.length ? [csvLine(s.header)] : []), ...s.rows.map(csvLine)]
    for (const l of lines) {
      parts.push(l)
      len += l.length + 1
      if (len > max + 1) return parts.join('\n')
    }
    parts.push('')
    len += 1
  }
  return parts.join('\n').trimEnd()
}

/** PDFs: pages read at most, and the wall-clock budget for the whole extraction. */
export const PDF_MAX_PAGES = 500
export const PDF_TIMEOUT_MS = 40_000

interface PdfDoc {
  numPages: number
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>
}

/** pdf.js's loading task: destroying it aborts a load still in progress and frees the document. */
interface PdfLoadingTask {
  promise: Promise<PdfDoc>
  destroy: () => Promise<void> | void
}

const itemText = (it: unknown) => {
  const o = it as { str?: unknown; hasEOL?: unknown }
  return `${typeof o.str === 'string' ? o.str : ''}${o.hasEOL ? '\n' : ''}`
}

/**
 * The text layer, page by page: at most PDF_MAX_PAGES pages, stopping once
 * past MAX_TEXT_CHARS, all within `timeoutMs`. null when it fails or runs out
 * of time. The loading task is kept and destroyed either way, so a load or a
 * page still in progress at the timeout is aborted, not left running.
 */
async function pdfText(bytes: Uint8Array, timeoutMs: number): Promise<{ text: string; truncated: boolean } | null> {
  let task: PdfLoadingTask | null = null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = (async () => {
    const { getResolvedPDFJS } = await import('unpdf')
    const { getDocument } = await getResolvedPDFJS()
    // pdf.js takes ownership of the buffer: hand it a copy. Text only: no font loading.
    if (stopped) return null
    task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }) as unknown as PdfLoadingTask
    const doc = await task.promise
    const pages = Math.min(doc.numPages, PDF_MAX_PAGES)
    let truncated = doc.numPages > PDF_MAX_PAGES
    const parts: string[] = []
    let len = 0
    for (let n = 1; n <= pages && !stopped; n++) {
      const content = await (await doc.getPage(n)).getTextContent()
      const t = content.items.map(itemText).join('')
      parts.push(t)
      len += t.length + 1
      if (len > MAX_TEXT_CHARS) {
        truncated = truncated || len - 1 > MAX_TEXT_CHARS || n < doc.numPages
        break
      }
    }
    return { text: parts.join('\n'), truncated }
  })()
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } catch {
    return null
  } finally {
    stopped = true
    clearTimeout(timer)
    work.catch(() => {})
    try {
      await (task as PdfLoadingTask | null)?.destroy()
    } catch {
      // released best effort
    }
  }
}

export async function extractText(bytes: Uint8Array, type: FileType, opts: { pdfTimeoutMs?: number } = {}): Promise<Extracted> {
  try {
    switch (type) {
      case 'image':
        return UNREADABLE
      case 'pdf': {
        const t = await pdfText(bytes, opts.pdfTimeoutMs ?? PDF_TIMEOUT_MS)
        return t === null ? UNREADABLE : capped(t.text, t.truncated)
      }
      case 'csv': {
        const t = decode(bytes)
        if (t === null) return UNREADABLE
        const head = csvHead(t)
        return capped(head.text, head.more)
      }
      case 'xlsx': {
        const parsed = await parseSpreadsheet(bytes, 'xlsx')
        return parsed.ok ? capped(workbookText(parsed.workbook)) : UNREADABLE
      }
      case 'text':
      case 'json': {
        const t = decode(bytes)
        return t === null ? UNREADABLE : capped(t)
      }
    }
  } catch {
    return UNREADABLE
  }
}
