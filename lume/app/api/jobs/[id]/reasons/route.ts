import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getJobReasons } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'

/**
 * `GET /api/jobs/<id>/reasons` → `{ reasons: [{ status, reason, n }] }`: the
 * job's status × MailTester reason counts (grouped in SQL). Read once a
 * minute while the job runs and once when it finishes, not on every 5 s
 * progress poll.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  try {
    return NextResponse.json({ reasons: await getJobReasons(id) })
  } catch (err) {
    return dbErrorResponse(err, 'api/jobs/[id]/reasons')
  }
}
