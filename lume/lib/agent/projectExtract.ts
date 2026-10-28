import { CSV_MAX_ROWS, MAX_TEXT_CHARS, type FileType } from '@/lib/agent/projectModel'

/**
 * Text extraction for project files, run once at upload:
 *  - CSV: header plus the first CSV_MAX_ROWS rows (quote-aware, so a quoted
 *    newline stays inside its row); line endings become \n.
 *  - PDF: the text layer (unpdf, a serverless build of pdf.js).
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

/** The header plus up to `maxRows` rows; `more` when rows were left out. */
export function csvHead(text: string, maxRows = CSV_MAX_ROWS): { text: string; more: boolean } {
  const rows: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') quoted = !quoted
    if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++
      rows.push(cur)
      cur = ''
      if (rows.length > maxRows + 1) break
      continue
    }
    cur += c
  }
  if (cur && rows.length <= maxRows + 1) rows.push(cur)
  const kept = rows.filter((r, i) => i === 0 || r.length > 0)
  const more = kept.length > maxRows + 1
  return { text: kept.slice(0, maxRows + 1).join('\n'), more }
}

async function pdfText(bytes: Uint8Array): Promise<string | null> {
  try {
    const { extractText: pdfExtract, getDocumentProxy } = await import('unpdf')
    // pdf.js takes ownership of the buffer: hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const { text } = await pdfExtract(pdf, { mergePages: true })
    return Array.isArray(text) ? text.join('\n') : text
  } catch {
    return null
  }
}

export async function extractText(bytes: Uint8Array, type: FileType): Promise<Extracted> {
  try {
    switch (type) {
      case 'image':
        return UNREADABLE
      case 'pdf': {
        const t = await pdfText(bytes)
        return t === null ? UNREADABLE : capped(t)
      }
      case 'csv': {
        const t = decode(bytes)
        if (t === null) return UNREADABLE
        const head = csvHead(t)
        return capped(head.text, head.more)
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
