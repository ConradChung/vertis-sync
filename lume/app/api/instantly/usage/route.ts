import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { getContactUsage } from '@/lib/adapters/instantlyLeads'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'

/** Uploaded contacts vs the Instantly outreach plan limit, with headroom. Uncached. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    return NextResponse.json({ configured: true, ...(await getContactUsage()) })
  } catch (err) {
    return instantlyErrorResponse(err, 'api/instantly/usage')
  }
}
