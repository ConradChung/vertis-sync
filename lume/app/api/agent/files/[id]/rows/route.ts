import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { fileInConversation, getChatFile, loadParsed } from '@/lib/agent/chatFiles'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { pickSheet, readWindow, READ_DEFAULT_ROWS, READ_MAX_ROWS } from '@/lib/sheets/model'

/**
 * GET `?sheet=<name | 1-based index>&offset=<row>&limit=<rows>&conversation=<id>`
 * → one page of an attached spreadsheet as CSV (the agent's read_attachment).
 * `{ file_id, name, sheet, sheets, header, offset, returned, total_rows,
 * next_offset, csv }`; ≤ 500 rows and ≤ 20k characters per page. With
 * `conversation`, the file must be attached to a message of that chat (404
 * otherwise), so a run only reads its own chat's files. 404 `sheet_not_found`
 * lists the sheet names.
 */

export const runtime = 'nodejs'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  const q = new URL(req.url).searchParams
  const conv = q.get('conversation')
  const conversationId = conv ? uuidParam(conv) : null
  if (conv && !conversationId) return NextResponse.json({ error: 'invalid_conversation' }, { status: 400 })
  const offset = Number(q.get('offset') ?? 0)
  const limit = Number(q.get('limit') ?? READ_DEFAULT_ROWS)
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > READ_MAX_ROWS) {
    return NextResponse.json({ error: 'invalid_range' }, { status: 400 })
  }
  try {
    const file = await getChatFile(id)
    if (!file || (conversationId && !(await fileInConversation(id, conversationId)))) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const wb = await loadParsed(id)
    if (!wb) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const sheet = pickSheet(wb.sheets, q.get('sheet'))
    const names = wb.sheets.map((s) => s.name)
    if (!sheet) return NextResponse.json({ error: 'sheet_not_found', sheets: names }, { status: 404 })
    return NextResponse.json({ file_id: id, name: file.name, sheet: sheet.name, sheets: names, header: sheet.header, ...readWindow(sheet, offset, limit) })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/files/[id]/rows')
  }
}
