import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { getPushPreview } from '@/lib/adapters/instantlyPush'
import { logEvent, pickCampaign, setBarriers } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { instantlyErrorResponse } from '@/lib/http/instantly'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { formAnswer, formRedirect, readJsonOrForm } from '@/lib/http/form'
import { currentOperator } from '@/lib/operators/session'
import { resolveCampaignQuery } from '@/lib/validate/campaignQuery'

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
 *   POST  { campaign_query } → the campaign by name, with telegram-inbox's
 *         reply rules (lib/validate/campaignQuery.ts): one exact or single
 *         match is picked as above; none → 400 no_campaign_match; several →
 *         409 several_matches + `matches` (nothing written).
 *   Both also as a plain HTML form (/operator): 303 back with a flash; on
 *   several matches the redirect carries `cq_job` + `cq` so the page lists
 *   the matches to pick from.
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

const PickBody = z.union([
  z.object({
    campaign_id: z.string().trim().min(1).max(100),
    campaign_name: z.string().max(300).optional(),
  }),
  z.object({ campaign_query: z.string().trim().min(1).max(200) }),
])

export async function POST(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const jobId = await jobIdOf(ctx)
  if (!jobId) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const body = await readJsonOrForm(req, PickBody, 2048, (f) => {
    const id = f.get('campaign_id')?.trim()
    if (id) return { campaign_id: id }
    return { campaign_query: f.get('campaign_query') ?? '' }
  })
  if (!body.ok) return body.response
  const form = body.form
  const answer = async (res: NextResponse, okText?: string) => (form ? formAnswer(req, form.returnTo, res, okText) : res)

  if (!isInstantlyConfigured()) return answer(NextResponse.json({ error: 'instantly_not_configured' }, { status: 400 }))
  // The id must be a real campaign; the stored name comes from Instantly, not the client.
  let campaign: { id: string; name: string } | undefined
  try {
    const all = await listCampaigns()
    if ('campaign_query' in body.data) {
      const query = body.data.campaign_query
      const r = resolveCampaignQuery(query, all)
      if (r.kind === 'several') {
        const matches = r.matches.map((c) => ({ id: c.id, name: c.name, status: c.status }))
        if (form) {
          const back = new URL(form.returnTo, 'http://x')
          back.searchParams.set('cq_job', jobId)
          back.searchParams.set('cq', query)
          return formRedirect(req, `${back.pathname}${back.search}`, { error: `${matches.length} campaigns match "${query}"; pick one` })
        }
        return NextResponse.json({ error: 'several_matches', matches }, { status: 409 })
      }
      if (r.kind !== 'resolved') {
        return answer(NextResponse.json({ error: form ? `No campaign matched "${query}"` : 'no_campaign_match' }, { status: 400 }))
      }
      campaign = r.campaign
    } else {
      const wanted = body.data.campaign_id
      campaign = all.find((c) => c.id === wanted)
    }
  } catch (err) {
    return answer(instantlyErrorResponse(err, 'api/gates/campaign'))
  }
  if (!campaign) return answer(NextResponse.json({ error: 'unknown_campaign' }, { status: 400 }))

  try {
    const moved = await pickCampaign(jobId, { id: campaign.id, name: campaign.name })
    if (!moved) return answer(NextResponse.json({ error: 'already_handled' }, { status: 409 }))
  } catch (err) {
    return answer(dbErrorResponse(err, 'api/gates/campaign'))
  }
  const op = await currentOperator(req)
  try {
    await logEvent({
      type: 'lume.campaign_pick',
      source: 'lume',
      source_id: jobId,
      campaign_id: campaign.id,
      title: op ? `Campaign picked by Grok Bot “${op.label}”: ${campaign.name}` : `Campaign picked in Lume: ${campaign.name}`,
      payload: { campaign_id: campaign.id, campaign_name: campaign.name, ...(op ? { decided_via: 'operator', operator_id: op.id } : {}) },
    })
  } catch (err) {
    console.error('[api/gates/campaign] logEvent failed:', err instanceof Error ? err.message : err)
  }
  return answer(NextResponse.json({ ok: true, campaign: { id: campaign.id, name: campaign.name } }), `Campaign set: ${campaign.name}`)
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
