import { NextResponse } from 'next/server'
import { requirePortalUser } from '@/lib/auth/guards'
import { createServiceClient } from '@/lib/supabase/service'
import { parsePortalLeadsQuery, portalLeadsResponse } from '@/lib/portal/leads'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/leads?tab=email|linkedin&q=&region=&has_phone=&status=replied_positive&sort=&page=
 * → PortalLeadsResponse (50 per page). Scoped to the portal user's own
 * campaigns / LinkedIn lists; owner preview with `?as=<portal email>`.
 */
export async function GET(req: Request) {
  const auth = await requirePortalUser(req)
  if (!auth.ok) return auth.response

  const parsed = parsePortalLeadsQuery(new URL(req.url).searchParams)
  if (!parsed.success) return NextResponse.json({ error: 'invalid_query' }, { status: 400 })

  try {
    const body = await portalLeadsResponse(createServiceClient(), auth.user, parsed.data)
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    console.error('[portal/leads] query failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'query_failed' }, { status: 502 })
  }
}
