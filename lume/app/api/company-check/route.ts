import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { companyCheckOverview } from '@/lib/companyCheck/action'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'

const FITS = new Set(['fit', 'not_fit', 'unclear'])

/**
 * GET `?job_id=&icp=&fit=&limit=&offset=` → the company check of one
 * validation job (lib/companyCheck/action.ts companyCheckOverview): the ICP
 * used, distinct companies and those still unchecked, the per-company price
 * with its sources and the total estimate, the run's spend and progress, and
 * a page of per-company results (most leads first). Reads only; nothing is spent.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const q = new URL(req.url).searchParams
  const jobId = uuidParam(q.get('job_id') ?? undefined)
  if (!jobId) return NextResponse.json({ error: 'invalid_job_id' }, { status: 400 })
  const icp = (q.get('icp') ?? '').trim()
  if (icp.length > 1000) return NextResponse.json({ error: 'icp_too_long' }, { status: 400 })
  const fit = q.get('fit') ?? undefined
  if (fit && !FITS.has(fit)) return NextResponse.json({ error: 'invalid_fit' }, { status: 400 })
  const limit = Number(q.get('limit') ?? 50)
  const offset = Number(q.get('offset') ?? 0)
  try {
    const o = await companyCheckOverview(jobId, {
      icp: icp || undefined,
      fit: fit as 'fit' | 'not_fit' | 'unclear' | undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    })
    if (!o) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json(o)
  } catch (err) {
    return dbErrorResponse(err, 'api/company-check')
  }
}
