import { NextResponse } from 'next/server'
import { requirePortalUser } from '@/lib/auth/guards'
import type { PortalMe } from '@/lib/portal/types'

export const dynamic = 'force-dynamic'

/** GET /api/portal/me → PortalMe. Owner preview: `?as=<portal email>`. */
export async function GET(req: Request) {
  const auth = await requirePortalUser(req)
  if (!auth.ok) return auth.response
  const body: PortalMe = { email: auth.user.email, client: auth.user.client }
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } })
}
