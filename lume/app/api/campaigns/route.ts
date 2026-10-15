import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getCampaigns } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'

/** `lume_campaigns` rows. Instantly analytics are merged in by Task 13. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await getCampaigns())
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns')
  }
}
