import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { downloadFileObject, getChatFile, insertChatFile, refOf, removeFileObjects, storeParsed } from '@/lib/agent/chatFiles'
import { FILE_PATH_RE, parsedPathFor } from '@/lib/agent/files'
import { verifyFileUploadTicket } from '@/lib/agent/fileTicket'
import { parseJsonBody } from '@/lib/http/json'
import { fileSummary, MAX_SHEET_FILE_BYTES, safeFileName, sheetMeta, sniffSpreadsheet, type ParseError } from '@/lib/sheets/model'
import { parseSpreadsheet } from '@/lib/sheets/parse'

/**
 * Step 2 of attaching a spreadsheet: the browser has put it at the signed
 * path. Body `{ storage_path, filename, upload_ticket }` → 201 `{ file }`
 * (a ChatFileRef: id, name, file_kind, size_bytes, sheets with row / column
 * counts). Checks, in order: the path is `<uuid>.<xlsx|csv>` (400), the
 * ticket is its HMAC (403), no file row exists for it yet (409), the object
 * exists (404) and is ≤ 10 MB (413). Then the MAGIC BYTES decide the type,
 * never the name or the Content-Type: a zip is parsed as .xlsx (and must
 * hold xl/workbook.xml), text as CSV; an OLE file (legacy .xls or a
 * password-protected workbook) and any other binary are refused (415). The
 * parse runs under the zip-bomb, 20-sheet and 500k-cell caps (422). The
 * parsed tables are stored as `<id>.json.gz` and the row records the counts
 * and the summary the agent gets. Any refusal or failure after the ticket
 * check deletes the uploaded object (and the parsed one).
 */

export const maxDuration = 60
export const runtime = 'nodejs'

const Body = z
  .object({ storage_path: z.string().max(64), filename: z.string().trim().min(1).max(255), upload_ticket: z.string().max(128) })
  .strict()

const PARSE_STATUS: Record<ParseError, number> = {
  empty: 422,
  not_xlsx: 415,
  not_csv: 415,
  legacy_or_encrypted: 415,
  too_large_uncompressed: 422,
  too_many_sheets: 422,
  too_many_cells: 422,
  too_many_columns: 422,
  unreadable: 422,
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  const { storage_path: path, upload_ticket } = body.data
  const m = FILE_PATH_RE.exec(path)
  if (!m) return NextResponse.json({ error: 'invalid_path' }, { status: 400 })
  if (!verifyFileUploadTicket(path, upload_ticket)) return NextResponse.json({ error: 'invalid_ticket' }, { status: 403 })
  const id = m[1]
  const name = safeFileName(body.data.filename)

  let keep = false
  const reject = async (error: string, status: number) => {
    if (!keep) await removeFileObjects([path, parsedPathFor(id)])
    return NextResponse.json({ error }, { status })
  }

  try {
    if (await getChatFile(id)) {
      keep = true
      return NextResponse.json({ error: 'already_added' }, { status: 409 })
    }
    const bytes = await downloadFileObject(path, MAX_SHEET_FILE_BYTES)
    if (bytes === null) return NextResponse.json({ error: 'upload_missing' }, { status: 404 })
    if (bytes === 'too_large') return await reject('too_large', 413)
    if (!bytes.length) return await reject('empty', 422)
    const sniff = sniffSpreadsheet(bytes)
    if (sniff === 'ole') return await reject('legacy_or_encrypted', 415)
    if (sniff === 'binary') return await reject('unsupported_media_type', 415)
    const kind = sniff === 'zip' ? 'xlsx' : 'csv'
    const parsed = await parseSpreadsheet(bytes, kind)
    if (!parsed.ok) return await reject(parsed.error, PARSE_STATUS[parsed.error])
    const sheets = parsed.workbook.sheets.map(sheetMeta)
    const summary = fileSummary({ id, name, kind, size_bytes: bytes.byteLength }, parsed.workbook)
    await storeParsed(id, parsed.workbook)
    try {
      const row = await insertChatFile({ id, name, kind, size_bytes: bytes.byteLength, storage_path: path, parsed_path: parsedPathFor(id), sheets, summary })
      keep = true
      return NextResponse.json({ file: refOf(row) }, { status: 201 })
    } catch (err) {
      // A racing finalize already wrote the row for this upload: its objects stay.
      if ((err as { cause?: { code?: unknown }; code?: unknown } | null)?.code === '23505') keep = true
      throw err
    }
  } catch (err) {
    console.error('[api/agent/files] failed:', err instanceof Error ? err.message : err)
    return await reject('storage', 502)
  }
}
