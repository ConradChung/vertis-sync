import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { signFileUpload } from '@/lib/agent/chatFiles'
import { sourcePathFor } from '@/lib/agent/files'
import { fileUploadTicket } from '@/lib/agent/fileTicket'
import { parseJsonBody } from '@/lib/http/json'
import { MAX_SHEET_FILE_BYTES } from '@/lib/sheets/model'

/**
 * Step 1 of attaching a spreadsheet to the Agent chat (or the Import
 * screen's .xlsx). Vercel refuses request bodies over ~4.5 MB and files go up
 * to 10 MB, so the browser uploads straight to Storage: this route checks the
 * declared name (.xlsx / .csv; .xls → 415 `xls`, "save as .xlsx") and size
 * (413 `too_large`), picks `<uuid>.<ext>` in the private `agent-chat-files`
 * bucket and returns a one-time signed upload token plus an `upload_ticket`
 * (purpose-bound HMAC, 15 min) that step 2 (`POST /api/agent/files`)
 * requires. Nothing here is trusted later: step 2 sniffs the bytes.
 */
const Body = z.object({ filename: z.string().trim().min(1).max(255), size: z.number().int().positive() }).strict()

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  const picked = sourcePathFor(body.data.filename)
  if ('error' in picked) return NextResponse.json({ error: picked.error }, { status: 415 })
  if (body.data.size > MAX_SHEET_FILE_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 })
  try {
    const signed = await signFileUpload(picked.path)
    return NextResponse.json({ path: picked.path, token: signed.token, signedUrl: signed.signedUrl, upload_ticket: fileUploadTicket(picked.path) })
  } catch (err) {
    console.error('[api/agent/files/sign] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'storage' }, { status: 502 })
  }
}
