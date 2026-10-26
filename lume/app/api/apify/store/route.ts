import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isApifyConfigured } from '@/lib/adapters/apify'
import { apifyErrorResponse } from '@/lib/apify/http'
import { storeShortlist } from '@/lib/apify/service'

/**
 * `GET /api/apify/store?q=<search>&limit=<n>` — an Apify Store shortlist,
 * ranked runnable-first (Lume can cap the run at $20), then by rating, reach
 * and 30-day success rate. Read-only.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  if (!isApifyConfigured()) return NextResponse.json({ error: 'apify_not_configured' }, { status: 503 })
  const params = new URL(req.url).searchParams
  const q = (params.get('q') ?? '').trim()
  if (!q || q.length > 200) return NextResponse.json({ error: 'q is required (≤ 200 chars)' }, { status: 400 })
  const limit = Math.min(Math.max(Number(params.get('limit')) || 8, 1), 20)
  try {
    return NextResponse.json(await storeShortlist(q, limit))
  } catch (err) {
    return apifyErrorResponse(err, 'api/apify/store')
  }
}
