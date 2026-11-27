import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { SIGNAL_SOURCES, MIN_DOORS_FILTER, SIGNAL_STATUSES, type SignalFilter } from '@/lib/signals/merge'
import { loadInbox } from '@/lib/signals/store'

export const dynamic = 'force-dynamic'

const pick = <T extends string>(v: string | null, allowed: readonly T[]): T | undefined => (v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined)

/**
 * GET /api/signals/inbox?source=hiring|comment|reddit|influencer&status=new|working|replied|dropped|open&q=&min_doors=500&sort=doors_desc|doors_asc
 * → `SignalInbox`: one row per company merged across the signal tables, with
 * its saved status and touches. Read only; the source tables are never written.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const sp = new URL(req.url).searchParams
  const filter: SignalFilter = {
    source: pick(sp.get('source'), SIGNAL_SOURCES) ?? 'all',
    status: pick(sp.get('status'), [...SIGNAL_STATUSES, 'open'] as const) ?? 'all',
    q: (sp.get('q') ?? '').slice(0, 120),
    ...(sp.get('min_doors') === String(MIN_DOORS_FILTER) ? { minDoors: MIN_DOORS_FILTER } : {}),
  }
  const sort = pick(sp.get('sort'), ['doors_desc', 'doors_asc'] as const)
  try {
    return NextResponse.json(await (sort ? loadInbox(filter, undefined, sort === 'doors_desc' ? 'desc' : 'asc') : loadInbox(filter)), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/signals/inbox')
  }
}
