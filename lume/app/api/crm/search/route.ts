import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { searchDeals } from '@/lib/crm/service'
import { dbErrorResponse } from '@/lib/http/errors'

/** `GET /api/crm/search?q=` → `{ deals }` (⌘K lead search over crm_deals: email, name, company). */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const q = (new URL(req.url).searchParams.get('q') ?? '').slice(0, 100)
  if (q.trim().length < 2) return NextResponse.json({ deals: [] })
  try {
    return NextResponse.json({ deals: await searchDeals(q) })
  } catch (err) {
    return dbErrorResponse(err, 'api/crm/search')
  }
}
