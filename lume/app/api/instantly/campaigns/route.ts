import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'

/** Instantly campaigns (all pages, deleted dropped, sorted by name). Cached 60 s. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    return NextResponse.json({ configured: true, campaigns: await listCampaigns() })
  } catch (err) {
    return instantlyErrorResponse(err, 'api/instantly/campaigns')
  }
}
