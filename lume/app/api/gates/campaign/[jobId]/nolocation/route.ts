import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { createCampaignFrom, getCampaignDetail } from '@/lib/adapters/instantlyWrite'
import { countLocationlessValid, getJobProgress, listCampaignTemplates, logEvent, setNoLocationCampaign } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { instantlyErrorResponse } from '@/lib/http/instantly'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { noLocationName, rankTemplates, stripLocationVariants } from '@/lib/validate/noLocation'

/**
 * The no-location sibling campaign for one validation job (Telegram's
 * "🗺 Create no-location campaign", now in Lume):
 *
 *   GET  → how many valid leads have no city, whether a sibling is set, and the
 *          options: the main campaign's copy minus its {{location}} variants
 *          (when every step keeps one), or a saved template.
 *   POST { mode: 'create', template_id? } → a new Instantly campaign mirroring
 *          the main one (inboxes, schedule, caps) with location-free copy, as a
 *          draft; the job's city-less leads route there on push.
 *   POST { mode: 'existing', campaign_id } → use a campaign that already exists.
 *
 * POST is the owner's own tap (session only, never the agent). Nothing is
 * pushed or launched here; the push itself is still a pending action.
 */

type Ctx = { params: Promise<{ jobId: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const jobId = uuidParam((await ctx.params).jobId)
  if (!jobId) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  try {
    const job = await getJobProgress(jobId)
    if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const [locationless, templates] = await Promise.all([countLocationlessValid(jobId), listCampaignTemplates()])
    let strip: { ok: boolean; removed?: number; kept?: number; reason?: string; step?: number } | null = null
    if (job.instantly_campaign_id && isInstantlyConfigured()) {
      try {
        const r = stripLocationVariants((await getCampaignDetail(job.instantly_campaign_id)).sequences)
        strip = r.ok ? { ok: true, removed: r.removed, kept: r.kept } : { ok: false, reason: r.reason, step: r.step }
      } catch (err) {
        console.error('[api/gates/campaign/nolocation] main campaign read failed:', err instanceof Error ? err.message : err)
      }
    }
    return NextResponse.json({
      locationless,
      main: job.instantly_campaign_id ? { id: job.instantly_campaign_id, name: job.instantly_campaign_name } : null,
      sibling: job.instantly_campaign_id_nolocation ? { id: job.instantly_campaign_id_nolocation, name: job.instantly_campaign_name_nolocation } : null,
      suggested_name: job.instantly_campaign_name ? noLocationName(job.instantly_campaign_name) : null,
      strip,
      templates: rankTemplates(templates).map((t) => ({ id: t.id, name: t.name })),
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/gates/campaign/nolocation')
  }
}

const Body = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), template_id: z.string().uuid().optional() }),
  z.object({ mode: z.literal('existing'), campaign_id: z.string().trim().min(1).max(100) }),
])

export async function POST(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const jobId = uuidParam((await ctx.params).jobId)
  if (!jobId) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  if (!isInstantlyConfigured()) return NextResponse.json({ error: 'instantly_not_configured' }, { status: 400 })

  const job = await getJobProgress(jobId).catch(() => null)
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!job.instantly_campaign_id || !job.instantly_campaign_name) return NextResponse.json({ error: 'pick_main_campaign_first' }, { status: 409 })
  if (job.instantly_campaign_id_nolocation) return NextResponse.json({ error: 'already_set' }, { status: 409 })

  let campaign: { id: string; name: string }
  try {
    if (body.data.mode === 'existing') {
      const wanted = body.data.campaign_id
      if (wanted === job.instantly_campaign_id) return NextResponse.json({ error: 'same_as_main' }, { status: 400 })
      const found = (await listCampaigns()).find((c) => c.id === wanted)
      if (!found) return NextResponse.json({ error: 'unknown_campaign' }, { status: 400 })
      campaign = { id: found.id, name: found.name }
    } else {
      let sequences: unknown
      const templateId = body.data.template_id
      if (templateId) {
        const t = (await listCampaignTemplates()).find((x) => x.id === templateId)
        if (!t) return NextResponse.json({ error: 'unknown_template' }, { status: 400 })
        sequences = t.sequences
      } else {
        const r = stripLocationVariants((await getCampaignDetail(job.instantly_campaign_id)).sequences)
        if (!r.ok) return NextResponse.json({ error: 'needs_template', reason: r.reason, step: r.step }, { status: 409 })
        sequences = r.sequences
      }
      campaign = await createCampaignFrom(job.instantly_campaign_id, noLocationName(job.instantly_campaign_name), sequences)
    }
  } catch (err) {
    return instantlyErrorResponse(err, 'api/gates/campaign/nolocation')
  }

  try {
    const r = await setNoLocationCampaign(jobId, campaign)
    if (r === 'push_awaiting_confirmation') return NextResponse.json({ error: 'push_awaiting_confirmation', campaign }, { status: 409 })
    if (r === 'moved') return NextResponse.json({ error: 'already_handled', campaign }, { status: 409 })
  } catch (err) {
    return dbErrorResponse(err, 'api/gates/campaign/nolocation')
  }
  await logEvent({
    type: 'lume.nolocation_campaign',
    source: 'lume',
    source_id: jobId,
    campaign_id: campaign.id,
    title: `No-location campaign ${body.data.mode === 'create' ? 'created' : 'set'}: ${campaign.name}`,
    payload: { campaign_id: campaign.id, campaign_name: campaign.name, mode: body.data.mode },
  }).catch((err) => console.error('[api/gates/campaign/nolocation] logEvent failed:', err instanceof Error ? err.message : err))
  return NextResponse.json({ ok: true, campaign })
}
