import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getValidationHistory } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { historyRow } from '@/lib/validate/stats'
import { displayNamesFor } from '@/lib/validate/previewStore'

/**
 * `GET /api/validation/history?page=0&page_size=25&days=30` → `{ rows, total,
 * page, page_size }`: completed validation jobs, newest first, each with its
 * source, total, valid / invalid / error % and top invalid reason. Grouped in
 * SQL (lume_validation_history). Owner, or the agent's bearer.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const sp = new URL(req.url).searchParams
  const page = Math.max(0, Number(sp.get('page')) || 0)
  const pageSize = Math.min(100, Math.max(1, Number(sp.get('page_size')) || 25))
  const days = Math.min(365, Math.max(1, Number(sp.get('days')) || 30))
  try {
    const { total, jobs } = await getValidationHistory({ days, limit: pageSize, offset: page * pageSize })
    // The owner's names live on validation_jobs.display_name (the RPC predates them).
    const names = await displayNamesFor(jobs.map((j) => j.id))
    for (const j of jobs) j.display_name = names.get(j.id) ?? null
    return NextResponse.json({ rows: jobs.map(historyRow), total, page, page_size: pageSize, days })
  } catch (err) {
    return dbErrorResponse(err, 'api/validation/history')
  }
}
