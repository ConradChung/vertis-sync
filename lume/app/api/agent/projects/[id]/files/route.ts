import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { addFile, getProject, itemByStoragePath, projectBytes } from '@/lib/agent/projects'
import { extractText } from '@/lib/agent/projectExtract'
import { fileTypeOf, MAX_FILE_BYTES, MAX_PROJECT_BYTES, mimeFor } from '@/lib/agent/projectModel'
import { downloadProjectObject, PROJECT_UPLOAD_PATH, removeProjectObjects } from '@/lib/agent/projectStorage'
import { badId, notFound } from '@/lib/agent/projectHttp'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { verifyUploadTicket } from '@/lib/import/ticket'

/**
 * Step 2 of adding a file: the browser has put it at the signed path.
 * Checks, in order: the path is `<this project>/<uuid>.<ext>` (400), the
 * ticket is its HMAC (403), the name's type is supported and matches the
 * path's extension (415), no item already points at it (409), the object
 * exists (404), it fits 20 MB and the project's 200 MB (413; the object is
 * removed). Then the text is extracted (lib/agent/projectExtract.ts) and the
 * item stored; a file with no extractable text is stored as not readable.
 * Body `{ storage_path, filename, upload_ticket, mime? }` → 201 `{ item }`.
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
  if (!verifyUploadTicket(path, upload_ticket)) return NextResponse.json({ error: 'invalid_ticket' }, { status: 403 })
  const type = fileTypeOf(filename)
  if (!type || fileTypeOf(`x.${m[2]}`) !== type) return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })

  try {
    if (!(await getProject(id))) return notFound()
    if (await itemByStoragePath(path)) return NextResponse.json({ error: 'already_added' }, { status: 409 })
    const bytes = await downloadProjectObject(path, MAX_FILE_BYTES)
    if (bytes === null) return NextResponse.json({ error: 'upload_missing' }, { status: 404 })
    if (bytes === 'too_large') {
      await removeProjectObjects([path])
      return NextResponse.json({ error: 'too_large' }, { status: 413 })
    }
    if ((await projectBytes(id)) + bytes.byteLength > MAX_PROJECT_BYTES) {
      await removeProjectObjects([path])
      return NextResponse.json({ error: 'project_full' }, { status: 413 })
    }
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
      return NextResponse.json({ item }, { status: 201 })
    } catch (err) {
      // No row points at the object (unless a racing finalize just wrote one).
      if ((err as { code?: unknown } | null)?.code !== '23505') await removeProjectObjects([path])
      throw err
    }
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/projects/[id]/files')
  }
}
