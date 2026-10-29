import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { addFile, clearPendingUpload, itemByStoragePath, projectBytes } from '@/lib/agent/projects'
import { extractText } from '@/lib/agent/projectExtract'
import { fileTypeOf, MAX_FILE_BYTES, MAX_PROJECT_BYTES, mimeFor } from '@/lib/agent/projectModel'
import { downloadProjectObject, PROJECT_UPLOAD_PATH, removeProjectObjects } from '@/lib/agent/projectStorage'
import { verifyProjectUploadTicket } from '@/lib/agent/projectTicket'
import { badId, projectErrorResponse, projectScope, requireProject } from '@/lib/agent/projectHttp'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * Step 2 of adding a file: the browser has put it at the signed path.
 * Checks, in order: the path is `<this project>/<uuid>.<ext>` (400), the
 * ticket is its purpose-bound HMAC (403), the name's type is supported and
 * matches the path's extension (415), the caller may use the project
 * (404 / 403), no item already points at it (409), the object exists (404),
 * it fits 20 MB and the project's 200 MB (413). Then the text is extracted
 * (lib/agent/projectExtract.ts: a PDF that takes over ~40 s is "not
 * readable") and the item stored. Any rejection or failure after the ticket
 * check removes the object and its pending-upload row (except a replay, whose
 * object belongs to the item already there). Body
 * `{ storage_path, filename, upload_ticket, mime? }` → 201 `{ item }`.
 */

export const maxDuration = 60
export const runtime = 'nodejs'

const Body = z
  .object({
    storage_path: z.string().max(120),
    filename: z.string().trim().min(1).max(255),
    upload_ticket: z.string().max(128),
    mime: z.string().max(100).optional(),
  })
  .strict()

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  const { storage_path: path, upload_ticket } = body.data
  const filename = body.data.filename.split(/[\\/]/).pop()!.slice(0, 200)

  const m = PROJECT_UPLOAD_PATH.exec(path)
  if (!m || m[1] !== id) return NextResponse.json({ error: 'invalid_path' }, { status: 400 })
  if (!verifyProjectUploadTicket(path, upload_ticket)) return NextResponse.json({ error: 'invalid_ticket' }, { status: 403 })

  // From here the path is one we signed: anything but success drops the object.
  let keep = false
  const discard = async () => {
    if (keep) return
    await removeProjectObjects([path])
    await clearPendingUpload(path)
  }
  const reject = async (error: string, status: number) => {
    await discard()
    return NextResponse.json({ error }, { status })
  }

  try {
    const type = fileTypeOf(filename)
    if (!type || fileTypeOf(`x.${m[2]}`) !== type) return await reject('unsupported_media_type', 415)
    const found = await requireProject(id, await projectScope(req, auth))
    if ('response' in found) {
      await discard()
      return found.response
    }
    if (await itemByStoragePath(path)) {
      keep = true
      return NextResponse.json({ error: 'already_added' }, { status: 409 })
    }
    const bytes = await downloadProjectObject(path, MAX_FILE_BYTES)
    if (bytes === null) return await reject('upload_missing', 404)
    if (bytes === 'too_large') return await reject('too_large', 413)
    if ((await projectBytes(id)) + bytes.byteLength > MAX_PROJECT_BYTES) return await reject('project_full', 413)
    const extracted = await extractText(bytes, type)
    try {
      const item = await addFile({
        project_id: id,
        name: filename,
        mime: mimeFor(type, filename, body.data.mime),
        size_bytes: bytes.byteLength,
        storage_path: path,
        text_content: extracted.text,
        readable: extracted.readable,
        truncated: extracted.truncated,
      })
      keep = true
      await clearPendingUpload(path)
      return NextResponse.json({ item }, { status: 201 })
    } catch (err) {
      // A racing finalize already wrote the row for this path: its object stays.
      if ((err as { code?: unknown } | null)?.code === '23505') keep = true
      throw err
    }
  } catch (err) {
    await discard()
    return projectErrorResponse(err, 'api/agent/projects/[id]/files')
  }
}
