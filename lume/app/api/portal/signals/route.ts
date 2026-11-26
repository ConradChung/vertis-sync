import { NextResponse } from 'next/server'
import { requirePortalUser } from '@/lib/auth/guards'
import { portalSeesSignals, portalSignalAccounts, type PortalSignalsResponse } from '@/lib/portal/signals'
import { getScoreboard } from '@/lib/scoreboard/store'
import { loadAllRows } from '@/lib/signals/store'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/signals → PortalSignalsResponse: today's signal accounts to
 * call (with phone numbers where known) and the weekly scoreboard, for the
 * client whose lanes produce the signals. Any other client gets
 * `{ enabled: false }` and no data. Read only; owner preview with `?as=`.
 */
export async function GET(req: Request) {
  const auth = await requirePortalUser(req)
  if (!auth.ok) return auth.response
  const off: PortalSignalsResponse = { enabled: false, accounts: [], more: 0, scoreboard: null }
  if (!portalSeesSignals(auth.user.client)) return NextResponse.json(off, { headers: { 'cache-control': 'no-store' } })
  try {
    const [{ rows }, scoreboard] = await Promise.all([
      loadAllRows(),
      getScoreboard().catch((err) => {
        console.error('[portal/signals] scoreboard failed:', err instanceof Error ? err.message : err)
        return null
      }),
    ])
    const body: PortalSignalsResponse = { enabled: true, ...portalSignalAccounts(rows), scoreboard }
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    console.error('[portal/signals] query failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'query_failed' }, { status: 502 })
  }
}
