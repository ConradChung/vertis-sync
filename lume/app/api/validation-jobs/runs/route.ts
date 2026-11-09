import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { listRuns } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'

/**
 * `GET /api/validation-jobs/runs?limit=20&offset=0&q=<name>` → `{ runs }`:
 * validation jobs of any status, latest activity first — Progress's run
 * switcher (and its "More runs" search). Read-only; owner or the agent's bearer.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const sp = new URL(req.url).searchParams
  const limit = Number(sp.get('limit')) || 20
  const offset = Number(sp.get('offset')) || 0
  const q = sp.get('q')?.slice(0, 80) ?? null
  try {
    return NextResponse.json({ runs: await listRuns({ limit, offset, q }) })
  } catch (err) {
    return dbErrorResponse(err, 'api/validation-jobs/runs')
  }
}
