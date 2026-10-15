import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getOrders } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'

/** Orders table (`lume_orders`), newest first. `?id=` detail arrives in Task 10. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const raw = new URL(req.url).searchParams.get('limit')
  const limit = raw && /^\d+$/.test(raw) ? Number(raw) : 100
  try {
    return NextResponse.json(await getOrders({ limit }))
  } catch (err) {
    return dbErrorResponse(err, 'api/orders')
  }
}
