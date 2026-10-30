import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { listRuns } from '@/lib/influencers/store'

/** `GET /api/influencers/runs` → `{ runs }`, the 10 newest pipeline runs. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ runs: await listRuns(10) })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/runs')
  }
}
