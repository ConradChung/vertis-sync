import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { campaignNames } from '@/lib/crm/board'
import { moveDeal } from '@/lib/crm/move'
import { getActivities, getAwaitingCloses, getDeal, getLeadRow, getStages, updateDeal, type DealPatch } from '@/lib/crm/service'
import type { CrmDealDetail, CrmPatchResult } from '@/lib/crm/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'

/**
 * One CRM deal.
 *  GET   → `CrmDealDetail` (deal, stages, timeline, lead_bank row, campaign name).
 *  PATCH → `{ stage?, reason?, owner?, next_action?, next_action_at?, notes? }`.
 *          Field edits apply directly. A stage move to Won/Lost (reason
 *          required) is filed as a `crm_close_deal` pending action — 202 with
 *          `pending_action_id`, nothing changes until it is approved; 409
 *          `close_awaiting` when one is already open. Other moves apply
 *          directly and are logged (source user).
 */
type Ctx = { params: Promise<{ id: string }> }

const Patch = z
  .object({
    stage: z.string().trim().min(1).max(60).optional(),
    reason: z.string().trim().max(300).optional(),
    owner: z.string().trim().max(80).nullable().optional(),
    next_action: z.string().trim().max(300).nullable().optional(),
    next_action_at: z.iso.datetime({ offset: true }).nullable().optional(),
    notes: z.string().max(20_000).nullable().optional(),
  })
  .strict()

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  try {
    const deal = await getDeal(id)
    if (!deal) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const [stages, activities, lead, awaiting, names] = await Promise.all([
      getStages(deal.campaign_id),
      getActivities(id),
      deal.lead_id !== null ? getLeadRow(deal.lead_id) : Promise.resolve(null),
      getAwaitingCloses(),
      campaignNames([deal.campaign_id]),
    ])
    const body: CrmDealDetail = {
      deal,
      stages,
      activities,
      lead,
      campaign_name: names.get(deal.campaign_id) ?? null,
      awaiting_close: awaiting[id] ?? null,
    }
    return NextResponse.json(body)
  } catch (err) {
    return dbErrorResponse(err, 'api/crm/deals/[id]')
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  const body = await parseJsonBody(req, Patch, 32 * 1024)
  if (!body.ok) return body.response
  const { stage, reason, ...fields } = body.data
  try {
    let deal = await getDeal(id)
    if (!deal) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const patch: DealPatch = {}
    if (fields.owner !== undefined) patch.owner = fields.owner || null
    if (fields.next_action !== undefined) patch.next_action = fields.next_action || null
    if (fields.next_action_at !== undefined) patch.next_action_at = fields.next_action_at
    if (fields.notes !== undefined) patch.notes = fields.notes || null
    if (Object.keys(patch).length) {
      deal = (await updateDeal(id, patch)) ?? deal
    }

    if (stage !== undefined) {
      const moved = await moveDeal(deal, stage, reason)
      if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: moved.status })
      const fresh = (await getDeal(id)) ?? deal
      if (!moved.applied) {
        const res: CrmPatchResult = { ok: true, applied: false, pending_action_id: moved.pending_action_id, deal: fresh }
        return NextResponse.json(res, { status: 202 })
      }
      deal = fresh
    }
    const res: CrmPatchResult = { ok: true, applied: true, deal }
    return NextResponse.json(res)
  } catch (err) {
    return dbErrorResponse(err, 'api/crm/deals/[id]')
  }
}
