import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { projectBytes, recordPendingUpload } from '@/lib/agent/projects'
import { fileTypeOf, MAX_FILE_BYTES, MAX_PROJECT_BYTES } from '@/lib/agent/projectModel'
import { signProjectUpload } from '@/lib/agent/projectStorage'
import { projectUploadTicket } from '@/lib/agent/projectTicket'
import { badId, projectErrorResponse, projectScope, requireProject } from '@/lib/agent/projectHttp'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * Step 1 of adding a file to a project: checks the declared name (CSV, PDF,
 * MD, TXT, JSON, images → else 415), size (20 MB → 413 too_large) and the
 * project's 200 MB total (413 project_full), picks the path
 * `<project>/<uuid>.<ext>`, records it in agent_project_uploads (an upload
 * that is never finalized is swept after an hour) and returns a one-time
 * signed upload token plus an `upload_ticket` (purpose-bound HMAC of the
 * path, 15 min) that step 2 requires.
 */
const Body = z.object({ filename: z.string().trim().min(1).max(255), size: z.number().int().nonnegative() }).strict()

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return badId()
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  const type = fileTypeOf(body.data.filename)
  if (!type) return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  if (body.data.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 })
  try {
    const found = await requireProject(id, await projectScope(req, auth))
    if ('response' in found) return found.response
    if ((await projectBytes(id)) + body.data.size > MAX_PROJECT_BYTES) return NextResponse.json({ error: 'project_full' }, { status: 413 })
    const ext = /\.([A-Za-z0-9]+)$/.exec(body.data.filename)![1].toLowerCase()
    const path = `${id}/${crypto.randomUUID()}.${ext}`
    // Recorded before the object can exist, so nothing is ever untracked.
    await recordPendingUpload(path, id)
    const signed = await signProjectUpload(path)
    return NextResponse.json({ path, token: signed.token, signedUrl: signed.signedUrl, upload_ticket: projectUploadTicket(path) })
  } catch (err) {
    return projectErrorResponse(err, 'api/agent/projects/[id]/files/sign')
  }
}
