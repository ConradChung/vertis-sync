import 'server-only'
import { getChatFile, loadParsed } from '@/lib/agent/chatFiles'
import { SourceError } from '@/lib/apollo/source'
import { leadColumnMapping, mappedRecord, rowRecord, UnknownColumnError, type ColumnMapping } from '@/lib/review/columns'
import { pickSheet } from '@/lib/sheets/model'

/**
 * One sheet of an attached spreadsheet as review-set rows: `raw` is the
 * sheet's own columns (all kept), `normalisable` the mapped record the review
 * set's normaliseLead reads. The mapping is detected from the header
 * (lib/review/columns.ts) with the caller's overrides winning, and returned
 * so the agent can show it. SourceError 404 file_not_found / sheet_not_found,
 * 422 empty_sheet, 400 unknown_column.
 */
export async function loadAttachmentLeads(fileId: string, sheetName: string | undefined, overrides: ColumnMapping = {}) {
  const file = await getChatFile(fileId)
  if (!file) throw new SourceError(404, 'file_not_found')
  const wb = await loadParsed(fileId)
  if (!wb) throw new SourceError(404, 'file_not_found')
  const sheet = pickSheet(wb.sheets, sheetName)
  if (!sheet) throw new SourceError(404, 'sheet_not_found')
  if (!sheet.rows.length) throw new SourceError(422, 'empty_sheet')
  let detected
  try {
    detected = leadColumnMapping(sheet.header, overrides)
  } catch (err) {
    if (err instanceof UnknownColumnError) throw new SourceError(400, 'unknown_column')
    throw err
  }
  const { mapping, unmapped } = detected
  return {
    kind: 'attachment' as const,
    id: fileId,
    label: `${file.name} · ${sheet.name}`,
    sheet: sheet.name,
    rows: sheet.rows.map((r) => rowRecord(sheet.header, r)),
    normalisable: (raw: Record<string, unknown>) => mappedRecord(raw as Record<string, string>, mapping),
    mapping,
    unmapped,
  }
}
