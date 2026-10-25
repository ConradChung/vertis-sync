import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { getRule } from '@/lib/actions/store'
import { parseCallbackData } from '@/lib/adapters/pipeline.actions'
import { getPushPreview } from '@/lib/adapters/instantlyPush'
import { getPushJob, PUSH_REVIEW_STATUSES } from '@/lib/db/service'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, UUID_RE } from '@/lib/http/json'

/**
 * Request a high-risk action (a `pending_actions` row + Telegram prompt).
 * Nothing runs here: the row waits for Confirm in Lume or Approve in
 * Telegram, and `lib/actions/execute.ts` runs it after that.
 *
 * The payload is a snapshot of what the owner confirms, built here from the
 * job row and the instantly-push preview (never from the client):
 * push_to_instantly = { job_id, campaign_id, location_barrier,
 * company_barrier, company_strict, eligible, summary }. Task 12's executor
 * compares the job's current columns to it before sending push_go.
 *
 * The other kinds take a strict, per-kind payload (unknown keys dropped) and
 * get a server-written summary.
 */

const JobBody = z.object({
  kind: z.enum(['push_to_instantly', 'launch_campaign']),
  payload: z.looseObject({ job_id: z.string().regex(UUID_RE) }),
})

const id = z.string().trim().min(1).max(128)
const optText = z.string().trim().max(500).optional()
const Lead = z.object({
  email: z.email().max(320),
  first_name: optText,
  last_name: optText,
  company_name: optText,
  website: optText,
  location: optText,
  personalization: z.string().max(5000).optional(),
  company_domain: optText,
  timezone: optText,
})

const OtherBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('decide_gate'),
    payload: z.object({ callback_data: z.string().min(1).max(128), job_id: z.string().regex(UUID_RE).optional() }),
  }),
  z.object({
    kind: z.literal('assign_leads'),
    payload: z.object({ campaign_id: id, campaign_name: optText, leads: z.array(Lead).min(1).max(2000) }),
  }),
  z.object({ kind: z.literal('activate_rule'), payload: z.object({ rule_id: z.string().regex(UUID_RE) }) }),
  z.object({ kind: z.literal('delete_rule'), payload: z.object({ rule_id: z.string().regex(UUID_RE) }) }),
  z.object({
    kind: z.literal('send_reply'),
    payload: z.object({
      eaccount: z.email().max(320),
      reply_to_uuid: id,
      subject: optText,
      body: z.string().trim().min(1).max(20000),
      to: optText,
    }),
  }),
  z.object({ kind: z.literal('pause_campaign'), payload: z.object({ campaign_id: id, campaign_name: optText }) }),
  z.object({ kind: z.literal('resume_campaign'), payload: z.object({ campaign_id: id, campaign_name: optText }) }),
  z.object({
    kind: z.literal('create_campaign'),
    payload: z.object({ source_campaign_id: id, source_name: optText, name: z.string().trim().min(1).max(200) }),
  }),
])

const Body = z.union([JobBody, OtherBody])

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
    case 'assign_leads': {
      const leads = b.payload.leads.map((l) => ({ ...l, email: l.email.toLowerCase() })) as unknown as Json[]
      return {
        payload: {
          campaign_id: b.payload.campaign_id,
          leads,
          count: leads.length,
          summary: `Queue ${fmt.format(leads.length)} leads for ${b.payload.campaign_name ?? b.payload.campaign_id}`,
        },
      }
    }
    case 'activate_rule':
    case 'delete_rule': {
      const ruleId = b.payload.rule_id.toLowerCase()
      const rule = await getRule(ruleId)
      if (!rule) return { error: 'rule_not_found', status: 404 }
      const verb = b.kind === 'activate_rule' ? 'Activate' : 'Delete'
      return { payload: { rule_id: ruleId, summary: `${verb} rotation rule “${rule.name}” (${rule.cron})` }, ruleId }
    }
    case 'send_reply': {
      const p = b.payload
      const preview = p.body.length > 140 ? `${p.body.slice(0, 140)}…` : p.body
      return {
        payload: {
          eaccount: p.eaccount,
          reply_to_uuid: p.reply_to_uuid,
          body: p.body,
          ...(p.subject ? { subject: p.subject } : {}),
          summary: `Reply from ${p.eaccount}${p.to ? ` to ${p.to}` : ''}: “${preview}”`,
        },
      }
    }
    case 'pause_campaign':
    case 'resume_campaign': {
      const verb = b.kind === 'pause_campaign' ? 'Pause' : 'Resume'
      return {
        payload: {
          campaign_id: b.payload.campaign_id,
          summary: `${verb} campaign ${b.payload.campaign_name ?? b.payload.campaign_id}`,
        },
      }
    }
    case 'create_campaign':
      return {
        payload: {
          source_campaign_id: b.payload.source_campaign_id,
          name: b.payload.name,
          summary: `Create campaign “${b.payload.name}” as a copy of ${b.payload.source_name ?? b.payload.source_campaign_id}`,
        },
      }
  }
}

const onOff = (v: boolean) => (v ? 'on' : 'off')
const fmt = new Intl.NumberFormat('en-US')

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  // assign_leads carries the lead rows; everything else is tiny.
  const body = await parseJsonBody(req, Body, 1024 * 1024)
  if (!body.ok) return body.response
  const requestedBy = auth.via === 'internal' ? 'agent' : 'user'

  try {
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
    if (err instanceof DuplicateActionError) {
      return NextResponse.json({ error: 'duplicate', existing_id: err.existingId || null }, { status: 409 })
    }
    if (err instanceof InvalidActionPayloadError) {
      return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
    }
    return dbErrorResponse(err, 'api/actions')
  }
}
