import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { getPushPreview } from '@/lib/adapters/instantlyPush'
import { logEvent, pickCampaign, setBarriers } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { instantlyErrorResponse } from '@/lib/http/instantly'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * Lume-local push settings for one validation job — the parts of the
 * Telegram push flow that are plain PATCHes, not entrypoint claims
 * (bar_loc / bar_co / push_strict / push_std / camp_pick), ported from the
 * root app's `/api/instantly/push`:
 *
 *   GET   → the `instantly-push` preview (mode:'preview', read-only)
 *   POST  { campaign_id, campaign_name } → campaign pick; only while the job
 *         awaits a campaign (conditional PATCH → 409 otherwise); moves it to
 *         `configuring` (the barrier screen)
 *   PATCH { location_barrier?, company_barrier?, company_strict? } → only
 *         while `configuring|reviewing_company` (409 otherwise) and no push
 *         confirmation is awaiting (409 push_awaiting_confirmation)
 *
 * Nothing here pushes to Instantly. "Push these" is a pending action.
 */

type Ctx = { params: Promise<{ jobId: string }> }

async function jobIdOf(ctx: Ctx) {
  return uuidParam((await ctx.params).jobId)
}

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const jobId = await jobIdOf(ctx)
  if (!jobId) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const r = await getPushPreview(jobId)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 })
  return NextResponse.json({ preview: r.preview })
}

const PickBody = z.object({
  campaign_id: z.string().trim().min(1).max(100),
  campaign_name: z.string().max(300).optional(),
})

export async function POST(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const jobId = await jobIdOf(ctx)
  if (!jobId) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const body = await parseJsonBody(req, PickBody, 2048)
  if (!body.ok) return body.response

  if (!isInstantlyConfigured()) return NextResponse.json({ error: 'instantly_not_configured' }, { status: 400 })
  // The id must be a real campaign; the stored name comes from Instantly, not the client.
  let campaign: { id: string; name: string } | undefined
  try {
    campaign = (await listCampaigns()).find((c) => c.id === body.data.campaign_id)
  } catch (err) {
    return instantlyErrorResponse(err, 'api/gates/campaign')
  }
  if (!campaign) return NextResponse.json({ error: 'unknown_campaign' }, { status: 400 })

  try {
    const moved = await pickCampaign(jobId, { id: campaign.id, name: campaign.name })
    if (!moved) return NextResponse.json({ error: 'already_handled' }, { status: 409 })
  } catch (err) {
    return dbErrorResponse(err, 'api/gates/campaign')
  }
  try {
    await logEvent({
      type: 'lume.campaign_pick',
      source: 'lume',
      source_id: jobId,
      campaign_id: campaign.id,
      title: `Campaign picked in Lume: ${campaign.name}`,
      payload: { campaign_id: campaign.id, campaign_name: campaign.name },
    })
  } catch (err) {
    console.error('[api/gates/campaign] logEvent failed:', err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ ok: true, campaign })
}

const BarrierBody = z
  .object({
    location_barrier: z.boolean().optional(),
    company_barrier: z.boolean().optional(),
    company_strict: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0)

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const jobId = await jobIdOf(ctx)
  if (!jobId) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const body = await parseJsonBody(req, BarrierBody, 1024)
  if (!body.ok) return body.response
  try {
    const saved = await setBarriers(jobId, body.data)
    if (saved === 'push_awaiting_confirmation') return NextResponse.json({ error: saved }, { status: 409 })
    if (saved !== 'ok') return NextResponse.json({ error: 'already_handled' }, { status: 409 })
  } catch (err) {
    return dbErrorResponse(err, 'api/gates/campaign')
  }
  try {
    await logEvent({
      type: 'lume.barriers',
      source: 'lume',
      source_id: jobId,
      title: `Push settings changed in Lume: ${Object.entries(body.data).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(', ')}`,
      payload: body.data,
    })
  } catch (err) {
    console.error('[api/gates/campaign] logEvent failed:', err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ ok: true })
}
