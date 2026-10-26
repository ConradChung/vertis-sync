import 'server-only'
import { z } from 'zod'
import { CAMPAIGN_ACTION_KINDS, parseCampaignPayload, type CampaignActionKind } from '@/lib/actions/payloads'
import { getRule } from '@/lib/actions/store'
import { parseCallbackData } from '@/lib/adapters/pipeline.actions'
import { getPushPreview } from '@/lib/adapters/instantlyPush'
import { getPushJob, PUSH_REVIEW_STATUSES } from '@/lib/db/service'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { UUID_RE } from '@/lib/http/json'
import { buildActivateRule, buildAssignLeads, rotateActionBody } from '@/lib/rules/actions'

/**
 * Turn a requested action `{ kind, payload }` into the snapshot the owner
 * confirms — the one server-side builder for every pending-action kind,
 * used by `POST /api/actions` (Lume clicks) and the orb agent's high-risk
 * tools, so a payload is identical whoever asked and always matches what
 * `lib/actions/execute.ts` reads. Never trusts a client summary.
 *
 *  push_to_instantly  { job_id, campaign_id, location_barrier, company_barrier,
 *                       company_strict, eligible, summary } (job row + preview)
 *  launch_campaign    { job_id, campaign_id, summary }
 *  assign_leads       { campaign_id, campaign_name, count, summary } + leads | filter
 *  activate_rule      { rule_id, rule_name, campaign_id, cron, tz, first_run, summary }
 *  delete_rule        { rule_id, summary }
 *  decide_gate        { callback_data, target_id, job_id?, summary }
 *  send_reply / pause_campaign / resume_campaign / create_campaign:
 *                     lib/actions/payloads.ts
 *
 * Rule kinds return `ruleId` for `createAction`'s `meta.ruleId`.
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

// Campaign kinds: the payload is checked by parseCampaignPayload.
const CampaignBody = z.object({
  kind: z.enum(CAMPAIGN_ACTION_KINDS),
  payload: z.record(z.string(), z.unknown()),
})

/** Shape check for `POST /api/actions`; `buildActionRequest` validates each payload fully. */
export const ActionRequestBody = z.union([JobBody, rotateActionBody, OtherBody, CampaignBody])
export type ActionRequest = z.infer<typeof ActionRequestBody>

export type ActionBuild =
  | { ok: true; kind: PendingActionKind; payload: Record<string, Json> & { summary: string }; ruleId?: string }
  | { ok: false; status: number; error: string }

// Gate steps that need their own confirmation flow never ride on decide_gate.
const NOT_VIA_DECIDE_GATE: ReadonlySet<string> = new Set(['push_go', 'camp_launch', 'lume_ok', 'lume_no'])

const onOff = (v: boolean) => (v ? 'on' : 'off')
const fmt = new Intl.NumberFormat('en-US')
const fail = (status: number, error: string): ActionBuild => ({ ok: false, status, error })

export async function buildActionRequest(input: unknown): Promise<ActionBuild> {
  const parsed = ActionRequestBody.safeParse(input)
  if (!parsed.success) return fail(400, 'invalid_payload')
  const req = parsed.data

  switch (req.kind) {
    case 'assign_leads': {
      const b = await buildAssignLeads(req.payload)
      return b.ok ? { ok: true, kind: req.kind, payload: b.payload } : b
    }
    case 'activate_rule': {
      const b = await buildActivateRule(req.payload)
      return b.ok ? { ok: true, kind: req.kind, payload: b.payload, ruleId: b.ruleId } : b
    }
    case 'decide_gate': {
      const p = req.payload
      const gate = parseCallbackData(p.callback_data)
      if (!gate) return fail(400, 'bad_callback_data')
      if (NOT_VIA_DECIDE_GATE.has(gate.action)) return fail(400, 'needs_confirmation')
      const payload: Record<string, Json> & { summary: string } = {
        callback_data: p.callback_data,
        target_id: gate.targetId,
        summary: `Gate decision ${gate.action} on ${gate.targetId.slice(0, 8)}`,
      }
      if (p.job_id) payload.job_id = p.job_id.toLowerCase()
      return { ok: true, kind: req.kind, payload }
    }
    case 'delete_rule': {
      const ruleId = req.payload.rule_id.toLowerCase()
      const rule = await getRule(ruleId)
      if (!rule) return fail(404, 'rule_not_found')
      return {
        ok: true,
        kind: req.kind,
        payload: { rule_id: ruleId, summary: `Delete rotation rule “${rule.name}” (${rule.cron})` },
        ruleId,
      }
    }
    case 'push_to_instantly':
    case 'launch_campaign':
      return buildJobAction(req.kind, (req.payload as { job_id: string }).job_id.toLowerCase())
    default: {
      const kind = req.kind as CampaignActionKind
      const p = parseCampaignPayload(kind, req.payload, { trustSummary: false })
      if (!p.ok) return fail(400, 'invalid_payload')
      return { ok: true, kind, payload: p.payload as Record<string, Json> & { summary: string } }
    }
  }
}

async function buildJobAction(kind: 'push_to_instantly' | 'launch_campaign', jobId: string): Promise<ActionBuild> {
  const job = await getPushJob(jobId)
  if (!job) return fail(404, 'job_not_found')
  if (!job.instantly_campaign_id) return fail(409, 'no_campaign')
  const campaign = job.instantly_campaign_name ?? job.instantly_campaign_id

  if (kind === 'launch_campaign') {
    if (job.instantly_status !== 'done' || !(job.instantly_pushed && job.instantly_pushed > 0)) return fail(409, 'job_not_ready')
    return {
      ok: true,
      kind,
      payload: {
        job_id: jobId,
        campaign_id: job.instantly_campaign_id,
        summary: `Launch ${campaign} (${fmt.format(job.instantly_pushed)} leads pushed from ${job.filename ?? jobId})`,
      },
    }
  }

  if (!(PUSH_REVIEW_STATUSES as readonly string[]).includes(job.instantly_status ?? '')) return fail(409, 'job_not_ready')
  const pv = await getPushPreview(jobId)
  if (!pv.ok) return fail(502, 'preview_failed')
  const { eligible, filtered } = pv.preview
  if (!eligible) return fail(409, 'nothing_to_push')
  // DB defaults: location off, company on, standard names.
  const location = job.location_barrier ?? false
  const company = job.company_barrier ?? true
  const strict = job.company_strict ?? false
  return {
    ok: true,
    kind,
    payload: {
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
    },
  }
}
