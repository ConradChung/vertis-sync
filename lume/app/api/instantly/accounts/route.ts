import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured, listAccounts } from '@/lib/adapters/instantly'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'

/** Sending accounts: `{email, status, warmup_status, warmup_score, daily_limit}` only. Cached 60 s. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    return NextResponse.json({ configured: true, accounts: await listAccounts() })
  } catch (err) {
    return instantlyErrorResponse(err, 'api/instantly/accounts')
  }
}
