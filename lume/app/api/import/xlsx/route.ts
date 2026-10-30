import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { AttachmentSheetError, ingestSheet, sheetForIngest } from '@/lib/agent/attachmentIngest'
import { parseJsonBody } from '@/lib/http/json'
import { ingestBody, intakeErrorResponse } from '@/lib/import/errors'

/**
 * Import card, .xlsx: the browser has uploaded and parsed the workbook
 * through `POST /api/agent/files/sign` + `POST /api/agent/files` (signed
 * Storage upload, magic bytes, zip-bomb caps) and, when it has several
 * sheets, asked which one. Body `{ file_id, sheet }` → the sheet as CSV into
 * the same intake as a CSV upload (`createIngest`: `raw-uploads`, a
 * `telegram_ingests` row `awaiting_approval`, telegram-inbox's own Approve /
 * Deny prompt) → the same answer as `POST /api/import/csv`. Approval and the
 * validation job stay in telegram-inbox. 404 file_not_found /
 * sheet_not_found (with `sheets`), 422 empty_sheet, 413 too_large.
 */

export const maxDuration = 60
export const runtime = 'nodejs'

const Body = z.object({ file_id: z.string().uuid(), sheet: z.string().min(1).max(200) }).strict()

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  try {
    const sheet = await sheetForIngest(body.data.file_id.toLowerCase(), body.data.sheet)
    // The pick must be exact here: the owner chose this sheet by name.
    if (sheet.sheet !== body.data.sheet) return NextResponse.json({ error: 'sheet_not_found', sheets: sheet.sheets }, { status: 404 })
    const result = await ingestSheet(sheet, `${sheet.file_name} · ${sheet.sheet}`)
    return NextResponse.json(ingestBody(result))
  } catch (err) {
    if (err instanceof AttachmentSheetError) return NextResponse.json({ error: err.code }, { status: err.status })
    return intakeErrorResponse(err, 'api/import/xlsx')
  }
}
