import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getGates } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'

/** Open gates (`lume_gates`), oldest first. Deciding one is Task 9's `/api/gates/decide`. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await getGates())
  } catch (err) {
    return dbErrorResponse(err, 'api/gates')
  }
}
