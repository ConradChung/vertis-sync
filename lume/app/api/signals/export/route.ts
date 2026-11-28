import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { exportCsv, exportFileName, type ExportTab } from '@/lib/signals/export'
import { MIN_DOORS_FILTER, SIGNAL_SOURCES, SIGNAL_STATUSES, type SignalFilter } from '@/lib/signals/merge'
import { loadExport } from '@/lib/signals/store'

export const dynamic = 'force-dynamic'

const pick = <T extends string>(v: string | null, allowed: readonly T[]): T | undefined => (v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined)

/**
 * GET /api/signals/export?source=all|comment|hiring|influencer&status=&q=&min_doors=500&sort=doors_desc|doors_asc
 * → a CSV of every account the Signals tab shows for those filters, over all
 * pages (same filter code as the inbox). Owner's own session only: a signed-out
 * request is 401, any other account (a portal client, a bearer token) is 403,
 * and nothing is read before that. The file carries scraped text, so it is
 * never cached.
 */
export async function GET(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const sp = new URL(req.url).searchParams
  const source = pick(sp.get('source'), SIGNAL_SOURCES) ?? 'all'
  if (source === 'reddit') return NextResponse.json({ error: 'not_exportable' }, { status: 400 })
  const filter: SignalFilter = {
    source,
    status: pick(sp.get('status'), [...SIGNAL_STATUSES, 'open'] as const) ?? 'all',
    q: (sp.get('q') ?? '').slice(0, 120),
    ...(sp.get('min_doors') === String(MIN_DOORS_FILTER) ? { minDoors: MIN_DOORS_FILTER } : {}),
  }
  const sort = pick(sp.get('sort'), ['doors_desc', 'doors_asc'] as const)
  const tab: ExportTab = source === 'hiring' ? 'hiring' : source === 'comment' ? 'comments' : 'all'
  try {
    const { rows, hiring } = await loadExport(filter, sort === 'doors_desc' ? 'desc' : sort === 'doors_asc' ? 'asc' : undefined)
    return new NextResponse(exportCsv(tab, rows, hiring), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFileName(tab, !!filter.minDoors)}"`,
        'Cache-Control': 'no-store',
        'X-Row-Count': String(rows.length),
      },
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/signals/export')
  }
}
