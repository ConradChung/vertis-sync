import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { monthStartIso } from '@/lib/hiring/engine'
import { getHiringConfig, hiringStatus, listHiringRows } from '@/lib/hiring/store'
import { parseListQuery } from '@/lib/hiring/view'

/** GTM-19 sheet: rows (newest first, filtered), the lanes and this month's spend. Owner only. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const q = parseListQuery(new URL(req.url).searchParams)
    const [list, cfg, status] = await Promise.all([listHiringRows(q), getHiringConfig(), hiringStatus(monthStartIso(new Date()))])
    return NextResponse.json({
      rows: list.rows,
      total: list.total,
      config: { dry_run: cfg.dry_run, lanes: cfg.lanes, monthly_cap_usd: cfg.monthly_cap_usd },
      month_to_date_usd: status.month_to_date_usd,
      last_runs: status.last_runs,
    })
  } catch (err) {
    console.error('[api/signals/hiring] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'hiring_list_failed' }, { status: 500 })
  }
}
