import 'server-only'
import { getChatFile, loadParsed } from '@/lib/agent/chatFiles'
import { detectedEmailColumn, MAX_CSV_BYTES } from '@/lib/import/csv'
import { createIngest, type IngestResult } from '@/lib/import/ingest'
import { pickSheet, sheetToIngestCsv } from '@/lib/sheets/model'

/**
 * One sheet of an attached spreadsheet → the Import CSV path. The sheet is
 * written as CSV (one row per line, as telegram-inbox reads files) and handed
 * to `createIngest`, the same intake the Import screen's Apify pull uses:
 * `raw-uploads/lume/<uuid>.csv` + a `telegram_ingests` row
 * `awaiting_approval` + telegram-inbox's own Approve / Deny prompt. The
 * validation job is created by telegram-inbox when the owner approves, never
 * here. Used by `POST /api/import/xlsx` (the Import card) and by the
 * approved `stage_attachment` action (the agent's stage_attachment_for_validation).
 */

export class AttachmentSheetError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'file_not_found' | 'sheet_not_found' | 'empty_sheet' | 'too_large'
  ) {
    super(code)
    this.name = 'AttachmentSheetError'
  }
}

export interface SheetForIngest {
  file_id: string
  file_name: string
  sheet: string
  /** Every sheet name, for a "which sheet?" answer. */
  sheets: string[]
  rows: number
  email_column: string | null
  filename: string
  csv: Uint8Array
}

/** The ingest file name: the file's own for a CSV; `<file> - <sheet>.csv` for a workbook. */
export function ingestFilename(fileName: string, kind: 'xlsx' | 'csv', sheet: string): string {
  const base = fileName.replace(/\.(xlsx|csv)$/i, '')
  const name = kind === 'csv' ? `${base}.csv` : `${base} - ${sheet}.csv`
  return name.replace(/[\\/\u0000-\u001f]+/g, ' ').slice(0, 200)
}

/** The sheet as ingest CSV, with its row count and the email column telegram-inbox will use. */
export async function sheetForIngest(fileId: string, sheetName?: string | null): Promise<SheetForIngest> {
  const file = await getChatFile(fileId)
  if (!file) throw new AttachmentSheetError(404, 'file_not_found')
  const wb = await loadParsed(fileId)
  if (!wb) throw new AttachmentSheetError(404, 'file_not_found')
  const sheet = pickSheet(wb.sheets, sheetName)
  if (!sheet) throw new AttachmentSheetError(404, 'sheet_not_found')
  if (!sheet.rows.length) throw new AttachmentSheetError(422, 'empty_sheet')
  const csv = new TextEncoder().encode(sheetToIngestCsv(sheet))
  if (csv.byteLength > MAX_CSV_BYTES) throw new AttachmentSheetError(413, 'too_large')
  return {
    file_id: file.id,
    file_name: file.name,
    sheet: sheet.name,
    sheets: wb.sheets.map((s) => s.name),
    rows: sheet.rows.length,
    email_column: detectedEmailColumn(sheet.header),
    filename: ingestFilename(file.name, file.kind, sheet.name),
    csv,
  }
}

export async function ingestSheet(s: SheetForIngest, detail: string): Promise<IngestResult> {
  return createIngest(s.csv, s.filename, { source: 'csv', detail })
}
