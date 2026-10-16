import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getJobProgress } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'

/** Progress of one validation job (counts, ETA, enrich, push settings). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  try {
    const job = await getJobProgress(id)
    if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json(job)
  } catch (err) {
    return dbErrorResponse(err, 'api/jobs/[id]')
  }
}
