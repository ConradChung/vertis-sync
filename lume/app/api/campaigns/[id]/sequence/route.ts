import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getCampaignSequence, isInstantlyConfigured } from '@/lib/adapters/instantly'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'
import { CAMPAIGN_ID_RE } from '@/lib/rules/schema'

/**
 * First three steps of an Instantly campaign's sequence (variant A, plain
 * text) for the Rotate rail. `id` is the Instantly campaign id
 * (`lume_campaigns.external_id`). Read-only, cached 60 s by the adapter.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  if (!CAMPAIGN_ID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    return NextResponse.json({ configured: true, steps: await getCampaignSequence(id, 3) })
  } catch (err) {
    return instantlyErrorResponse(err, 'api/campaigns/[id]/sequence')
  }
}
