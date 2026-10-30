import 'server-only'
import { createHash } from 'node:crypto'
import { getChatFile, loadParsed } from '@/lib/agent/chatFiles'
import { findIngestByStoragePath } from '@/lib/db/service'
import { StorageError } from '@/lib/import/storage'
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
 *
 * One ingest per file + sheet, whichever door it came through: the ingest's
 * `raw-uploads` path is derived from (file id, sheet), an existing ingest at
 * that path is 409 `already_ingested`, and the upload is exclusive, so two
 * concurrent requests cannot both create one.
 */

export class AttachmentSheetError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'file_not_found' | 'sheet_not_found' | 'empty_sheet' | 'too_large' | 'already_ingested'
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
  /** The ingest's raw-uploads path for this file + sheet (fixed, so a repeat is caught). */
  storage_path: string
}

/** `lume/<uuid>.csv` from sha256(file id, sheet): the same sheet always maps to the same ingest path. */
export function ingestPathFor(fileId: string, sheet: string): string {
  const h = createHash('sha256').update(`agent-chat-file-ingest|${fileId}|${sheet}`).digest('hex')
  const v = `5${h.slice(13, 16)}`
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20)
  return `lume/${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}-${h.slice(20, 32)}.csv`
}

/** Throws AttachmentSheetError 409 already_ingested when this sheet already has an ingest. */
export async function assertNotIngested(s: Pick<SheetForIngest, 'storage_path'>): Promise<void> {
  if (await findIngestByStoragePath(s.storage_path)) throw new AttachmentSheetError(409, 'already_ingested')
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
    storage_path: ingestPathFor(file.id, sheet.name),
  }
}

/** Storage refused the exclusive upload because the object exists: another request ingested this sheet. */
const isDuplicateUpload = (err: unknown) => err instanceof StorageError && (err.status === 409 || /duplicate|already exists/i.test(err.message))

/** Checks for an earlier ingest, then the CSV intake at the sheet's fixed path. */
export async function ingestSheet(s: SheetForIngest, detail: string): Promise<IngestResult> {
  await assertNotIngested(s)
  try {
    return await createIngest(s.csv, s.filename, { source: 'csv', detail, storagePath: s.storage_path })
  } catch (err) {
    if (isDuplicateUpload(err)) throw new AttachmentSheetError(409, 'already_ingested')
    throw err
  }
}
