import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { CAMPAIGN_ACTION_KINDS, parseCampaignPayload, type CampaignActionKind } from '@/lib/actions/payloads'
import { getRule } from '@/lib/actions/store'
import { parseCallbackData } from '@/lib/adapters/pipeline.actions'
import { getPushPreview } from '@/lib/adapters/instantlyPush'
import { getPushJob, PUSH_REVIEW_STATUSES } from '@/lib/db/service'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, UUID_RE } from '@/lib/http/json'
import { buildActivateRule, buildAssignLeads, rotateActionBody, type RotateBuild } from '@/lib/rules/actions'

/**
 * Request a high-risk action (a `pending_actions` row + Telegram prompt).
 * Kinds: `push_to_instantly`, `launch_campaign` (Validate), `assign_leads`,
 * `activate_rule` (Rotate — built by lib/rules/actions.ts), and `delete_rule`,
 * `send_reply`, `pause_campaign`, `resume_campaign`, `create_campaign`,
 * `decide_gate` (Campaigns, the agent). Nothing runs here: the row waits for
 * Confirm in Lume or Approve in Telegram, and `lib/actions/execute.ts` runs
 * it after that.
 *
 * The payload is a snapshot of what the owner confirms, built here from the
 * job row and the instantly-push preview (never from the client):
 * push_to_instantly = { job_id, campaign_id, location_barrier,
 * company_barrier, company_strict, eligible, summary }. Task 12's executor
 * compares the job's current columns to it before sending push_go.
 *
 * The campaign kinds (`send_reply`, `pause_campaign`, `resume_campaign`,
 * `create_campaign`) are validated by `parseCampaignPayload`
 * (lib/actions/payloads.ts — the same validator createAction runs); the
 * other kinds take a strict, per-kind payload here. Unknown keys are dropped
 * and the summary is always server-written.
 */

const JobBody = z.object({
  kind: z.enum(['push_to_instantly', 'launch_campaign']),
  payload: z.looseObject({ job_id: z.string().regex(UUID_RE) }),
})

const OtherBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('decide_gate'),
    payload: z.object({ callback_data: z.string().min(1).max(128), job_id: z.string().regex(UUID_RE).optional() }),
  }),
  z.object({ kind: z.literal('delete_rule'), payload: z.object({ rule_id: z.string().regex(UUID_RE) }) }),
])

// Campaign kinds: the payload is checked by parseCampaignPayload below.
const CampaignBody = z.object({
  kind: z.enum(CAMPAIGN_ACTION_KINDS),
  payload: z.record(z.string(), z.unknown()),
})

// assign_leads / activate_rule: rotateActionBody (lib/rules/actions.ts) — one
// payload shape for drag-drop, the rotation tick and the agent.
const Body = z.union([JobBody, rotateActionBody, OtherBody, CampaignBody])

// Gate steps that need their own confirmation flow never ride on decide_gate.
const NOT_VIA_DECIDE_GATE: ReadonlySet<string> = new Set(['push_go', 'camp_launch', 'lume_ok', 'lume_no'])

type Other = z.infer<typeof OtherBody>
type Built = { payload: Record<string, Json>; ruleId?: string } | { error: string; status: number }

async function buildOther(b: Other): Promise<Built> {
  switch (b.kind) {
    case 'decide_gate': {
      const parsed = parseCallbackData(b.payload.callback_data)
      if (!parsed) return { error: 'bad_callback_data', status: 400 }
      if (NOT_VIA_DECIDE_GATE.has(parsed.action)) return { error: 'needs_confirmation', status: 400 }
      const payload: Record<string, Json> = {
        callback_data: b.payload.callback_data,
        target_id: parsed.targetId,
        summary: `Gate decision ${parsed.action} on ${parsed.targetId.slice(0, 8)}`,
      }
      if (b.payload.job_id) payload.job_id = b.payload.job_id.toLowerCase()
      return { payload }
    }
    case 'delete_rule': {
      const ruleId = b.payload.rule_id.toLowerCase()
      const rule = await getRule(ruleId)
      if (!rule) return { error: 'rule_not_found', status: 404 }
      return { payload: { rule_id: ruleId, summary: `Delete rotation rule “${rule.name}” (${rule.cron})` }, ruleId }
    }
  }
}

const MAX_BODY_BYTES = 1024 * 1024

const onOff = (v: boolean) => (v ? 'on' : 'off')
const fmt = new Intl.NumberFormat('en-US')

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  // assign_leads carries up to 500 lead refs; send_reply up to 20k chars.
  const body = await parseJsonBody(req, Body, MAX_BODY_BYTES)
  if (!body.ok) return body.response
  const requestedBy = auth.via === 'internal' ? 'agent' : 'user'

  try {
    if (body.data.kind === 'assign_leads' || body.data.kind === 'activate_rule') {
      const data = body.data as z.infer<typeof rotateActionBody>
      const built: RotateBuild =
        data.kind === 'assign_leads' ? await buildAssignLeads(data.payload) : await buildActivateRule(data.payload)
      if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status })
      const action = await createAction(data.kind, built.payload, requestedBy, { ruleId: built.ruleId ?? null })
      return NextResponse.json(
        { ok: true, action: { id: action.id, kind: action.kind, summary: built.payload.summary } },
        { status: 201 }
      )
    }
    if ((CAMPAIGN_ACTION_KINDS as readonly string[]).includes(body.data.kind)) {
      const kind = body.data.kind as CampaignActionKind
      const parsed = parseCampaignPayload(kind, body.data.payload, { trustSummary: false })
      if (!parsed.ok) return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
      const action = await createAction(kind, parsed.payload, requestedBy)
      return NextResponse.json(
        { ok: true, action: { id: action.id, kind: action.kind, summary: action.payload?.summary ?? parsed.payload.summary } },
        { status: 201 }
      )
    }
    if (body.data.kind !== 'push_to_instantly' && body.data.kind !== 'launch_campaign') {
      const built = await buildOther(body.data as Other)
      if ('error' in built) return NextResponse.json({ error: built.error }, { status: built.status })
      const action = await createAction(body.data.kind as PendingActionKind, built.payload, requestedBy, { ruleId: built.ruleId })
      return NextResponse.json(
        { ok: true, action: { id: action.id, kind: action.kind, summary: built.payload.summary } },
        { status: 201 }
      )
    }
    const { kind } = body.data
    const jobId = (body.data.payload as { job_id: string }).job_id.toLowerCase()

    const job = await getPushJob(jobId)
    if (!job) return NextResponse.json({ error: 'job_not_found' }, { status: 404 })
    if (!job.instantly_campaign_id) return NextResponse.json({ error: 'no_campaign' }, { status: 409 })
    const campaign = job.instantly_campaign_name ?? job.instantly_campaign_id

    let payload: Record<string, Json>
    if (kind === 'push_to_instantly') {
      if (!(PUSH_REVIEW_STATUSES as readonly string[]).includes(job.instantly_status ?? '')) {
        return NextResponse.json({ error: 'job_not_ready' }, { status: 409 })
      }
      const pv = await getPushPreview(jobId)
      if (!pv.ok) return NextResponse.json({ error: 'preview_failed' }, { status: 502 })
      const { eligible, filtered } = pv.preview
      if (!eligible) return NextResponse.json({ error: 'nothing_to_push' }, { status: 409 })
      // DB defaults: location off, company on, standard names.
      const location = job.location_barrier ?? false
      const company = job.company_barrier ?? true
      const strict = job.company_strict ?? false
      payload = {
        job_id: jobId,
        campaign_id: job.instantly_campaign_id,
        location_barrier: location,
        company_barrier: company,
        company_strict: strict,
        eligible,
        summary:
          `Push ${fmt.format(eligible)} leads from ${job.filename ?? jobId} → ${campaign}` +
          ` (${fmt.format(filtered)} filtered; location ${onOff(location)}, company ${onOff(company)}, ` +
          `${strict ? 'stricter' : 'standard'} names)`,
      }
    } else {
      if (job.instantly_status !== 'done' || !(job.instantly_pushed && job.instantly_pushed > 0)) {
        return NextResponse.json({ error: 'job_not_ready' }, { status: 409 })
      }
      payload = {
        job_id: jobId,
        campaign_id: job.instantly_campaign_id,
        summary: `Launch ${campaign} (${fmt.format(job.instantly_pushed)} leads pushed from ${job.filename ?? jobId})`,
      }
    }

    const action = await createAction(kind, payload, requestedBy)
    return NextResponse.json({ ok: true, action: { id: action.id, kind: action.kind, summary: payload.summary } }, { status: 201 })
  } catch (err) {
    return actionError(err)
  }
}

function actionError(err: unknown) {
  if (err instanceof DuplicateActionError) {
    return NextResponse.json({ error: 'duplicate', existing_id: err.existingId || null }, { status: 409 })
  }
  if (err instanceof InvalidActionPayloadError) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }
  return dbErrorResponse(err, 'api/actions')
}
