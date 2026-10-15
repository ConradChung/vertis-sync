import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getLeadBank } from '@/lib/db/service'
import { parseLeadBankParams } from '@/lib/db/leadBankQuery'
import { dbErrorResponse } from '@/lib/http/errors'

/**
 * Paged, filtered `lume_lead_bank`.
 * `?origin=lead_bank|validation_rows&icp_status=&city=&since=YYYY-MM-DD&page=1&pageSize=100`
 * → `{ rows, total, page, pageSize }`.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const params = parseLeadBankParams(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await getLeadBank(params))
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-bank')
  }
}
