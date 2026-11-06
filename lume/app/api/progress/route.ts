import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { buildProgress } from '@/lib/progress/build'

/**
 * `GET /api/progress` → `{ running, recent, unavailable? }`: one queue of
 * every live process and those finished in the last 24 h (owner only; read).
 * Sources fail on their own, so this never 500s for one bad source.
 */
export const maxDuration = 30

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  return NextResponse.json(await buildProgress())
}
