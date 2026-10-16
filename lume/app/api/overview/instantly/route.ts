import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { buildOverviewInstantly } from '@/lib/overview/build'

/**
 * Instantly half of the Overview (`OverviewInstantly`): workspace KPIs,
 * accounts and the campaign strip. Polled by the page every 60 s; the adapter
 * caches upstream calls, so this never fans out per Realtime insert. Without
 * `INSTANTLY_API_KEY` it is `{configured:false, campaigns}` (the Gmail/Muse
 * strip rows still come from the database).
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await buildOverviewInstantly(new Date()))
  } catch (err) {
    return dbErrorResponse(err, 'api/overview/instantly')
  }
}
