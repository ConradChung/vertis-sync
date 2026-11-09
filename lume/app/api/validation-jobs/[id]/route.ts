import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { DisplayNameBody } from '@/lib/validate/preview'
import { renameJob } from '@/lib/validate/previewStore'

/**
 * `PATCH /api/validation-jobs/<id>` `{ display_name }` → `{ job }`: rename a
 * validated list (1–120 characters; empty or null goes back to the filename).
 * A label only — the validator never reads it. Owner or the agent's bearer
 * (like renaming a lead list).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const body = await parseJsonBody(req, DisplayNameBody, 4 * 1024)
  if (!body.ok) return body.response
  try {
    const job = await renameJob(id, body.data.display_name)
    if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ job })
  } catch (err) {
    return dbErrorResponse(err, 'api/validation-jobs/[id]')
  }
}
