import 'server-only'
import { z } from 'zod'
import { CAMPAIGN_ACTION_KINDS, parseCampaignPayload, type CampaignActionKind } from '@/lib/actions/payloads'
import { getEmailLead, isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { getRule } from '@/lib/actions/store'
import { parseCallbackData } from '@/lib/adapters/pipeline.actions'
import { getPushPreview } from '@/lib/adapters/instantlyPush'
import { getCampaignByExternalId, getInstantlyEmailEvent, getPushJob, PUSH_REVIEW_STATUSES } from '@/lib/db/service'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { UUID_RE } from '@/lib/http/json'
import { buildActivateRule, buildAssignLeads, rotateActionBody } from '@/lib/rules/actions'
import { ACTOR_ID_RE, checkRunActor, runActorPayload } from '@/lib/apify/service'
import { ACTOR_RUN_CAP_USD } from '@/lib/apify/pricing'
import { buildUpdateSequence } from '@/lib/campaigns/sequenceAction'
import { getVertical } from '@/lib/operators/store'
import { buildRemoveLeads, removeLeadsBody } from '@/lib/actions/removeLeads'
import { getEmail } from '@/lib/adapters/instantlyEmails'
import { findDeal, findLeadByEmail } from '@/lib/crm/service'
import { labelPlan, trimQuotes, type InboxEmail } from '@/lib/inbox/model'
import { LabelBody } from '@/lib/inbox/schemas'

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
 *  issue_operator_key { vertical_id, label? } → { vertical_id, vertical_name, label, summary }
 *                     (a live vertical; never a master key)
 *  run_actor          { actor_id, input, max_charge_usd?, expected_items? } →
 *                     lib/apify/service.ts: input validated against the
 *                     actor's schema, run options capped at $20, summary
 *  remove_leads       { campaign_id, reason, lead_ids | filter } → lib/actions/removeLeads.ts:
 *                     Instantly read now, replied / interested dropped, ids frozen
 *  update_sequence    { campaign_id, steps, base_hash? } → lib/campaigns/sequenceAction.ts:
 *                     fresh Instantly read, stale check, diff, frozen PATCH body
 *  send_reply / pause_campaign / resume_campaign / create_campaign:
 *                     lib/actions/payloads.ts, with the display extras
 *                     written here (`withServerExtras`): the campaign name
 *                     and the reply recipient, never the caller's
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
  z.object({
    kind: z.literal('issue_operator_key'),
    payload: z.object({ vertical_id: z.string().regex(UUID_RE), label: z.string().trim().min(1).max(80).optional() }),
  }),
])

// Campaign kinds: the payload is checked by parseCampaignPayload.
const CampaignBody = z.object({
  kind: z.enum(CAMPAIGN_ACTION_KINDS),
  payload: z.record(z.string(), z.unknown()),
})

const RunActorBody = z.object({
  kind: z.literal('run_actor'),
  payload: z.object({
    actor_id: z.string().regex(ACTOR_ID_RE),
    input: z.record(z.string(), z.unknown()),
    max_charge_usd: z.number().positive().max(ACTOR_RUN_CAP_USD).optional(),
    expected_items: z.number().int().positive().max(1_000_000).optional(),
  }),
})

const UpdateSequenceBody = z.object({ kind: z.literal('update_sequence'), payload: z.record(z.string(), z.unknown()) })
const RemoveLeadsBody = z.object({ kind: z.literal('remove_leads'), payload: z.record(z.string(), z.unknown()) })
const LabelReplyBody = z.object({ kind: z.literal('label_reply'), payload: z.record(z.string(), z.unknown()) })

/** Shape check for `POST /api/actions`; `buildActionRequest` validates each payload fully. */
export const ActionRequestBody = z.union([JobBody, rotateActionBody, OtherBody, RunActorBody, UpdateSequenceBody, RemoveLeadsBody, LabelReplyBody, CampaignBody])
export type ActionRequest = z.infer<typeof ActionRequestBody>

export type ActionBuild =
  | { ok: true; kind: PendingActionKind; payload: Record<string, Json> & { summary: string }; ruleId?: string }
  | { ok: false; status: number; error: string; problems?: string[] }

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
    case 'issue_operator_key': {
      const v = await getVertical(req.payload.vertical_id.toLowerCase())
      if (!v || v.archived_at) return fail(404, 'vertical_not_found')
      const label = req.payload.label ?? `${v.name} bot`
      return {
        ok: true,
        kind: req.kind,
        payload: {
          vertical_id: v.id,
          vertical_name: v.name,
          label,
          summary: `Issue a Grok Bot operator key “${label}” for the ${v.name} vertical (full owner rights; sign-in link shown once to whoever approves)`,
        },
      }
    }
    case 'run_actor': {
      const r = req.payload
      const input = JSON.parse(JSON.stringify(r.input)) as Record<string, unknown>
      const check = await checkRunActor({ ...r, input })
      if (!check.ok) return fail(check.status, check.error)
      return { ok: true, kind: req.kind, payload: runActorPayload({ ...r, input }, check.brief, check.plan) }
    }
    case 'update_sequence': {
      const b = await buildUpdateSequence(req.payload, campaignName)
      return b.ok ? { ok: true, kind: req.kind, payload: b.payload } : b
    }
    case 'remove_leads': {
      const r = removeLeadsBody.safeParse(req.payload)
      if (!r.success) return fail(400, 'invalid_payload')
      const b = await buildRemoveLeads(r.data, { campaignName })
      return b.ok ? { ok: true, kind: req.kind, payload: b.payload } : b
    }
    case 'label_reply':
      return buildLabelReply(req.payload)
    case 'push_to_instantly':
    case 'launch_campaign':
      return buildJobAction(req.kind, (req.payload as { job_id: string }).job_id.toLowerCase())
    default: {
      const kind = req.kind as CampaignActionKind
      const extras = await withServerExtras(kind, req.payload)
      if ('error' in extras) return fail(400, extras.error)
      const p = parseCampaignPayload(kind, extras.payload, { trustSummary: false })
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

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Campaign name: `lume_campaigns`, then Instantly's list (cached read), else the id. */
async function campaignName(id: string): Promise<string> {
  try {
    const c = await getCampaignByExternalId(id)
    if (c?.name) return c.name
  } catch (err) {
    console.error('[actions/build] lume_campaigns lookup failed:', err instanceof Error ? err.message : err)
  }
  if (isInstantlyConfigured()) {
    try {
      const c = (await listCampaigns()).find((x) => x.id === id)
      if (c?.name) return c.name
    } catch (err) {
      console.error('[actions/build] Instantly campaign lookup failed:', err instanceof Error ? err.message : err)
    }
  }
  return id
}

/** The lead a reply goes to: the webhook event for that email, then Instantly's email read. */
async function replyRecipient(replyToUuid: string): Promise<{ lead: string; campaign_id: string | null } | null> {
  try {
    const e = await getInstantlyEmailEvent(replyToUuid)
    if (e?.lead_email) return { lead: e.lead_email.toLowerCase(), campaign_id: e.campaign_id }
  } catch (err) {
    console.error('[actions/build] email event lookup failed:', err instanceof Error ? err.message : err)
  }
  if (isInstantlyConfigured()) {
    try {
      const e = await getEmailLead(replyToUuid)
      if (e.lead) return { lead: e.lead, campaign_id: e.campaign_id }
    } catch (err) {
      console.error('[actions/build] Instantly email lookup failed:', err instanceof Error ? err.message : err)
    }
  }
  return null
}

/**
 * Overwrite a campaign-kind payload's display extras server-side, so the
 * confirmation (and its Telegram prompt) can never be steered by the caller:
 * `campaign_name` is looked up from the campaign id; for send_reply,
 * `lead_email` is the looked-up recipient (`recipient_verified: true`), or the
 * caller's claim marked `recipient_verified: false` when no lookup knows it.
 *
 * send_reply, when Instantly has the email (cached read, lib/adapters/
 * instantlyEmails.ts): the reply goes from the SAME inbox that received it
 * (`eaccount` overwritten), in its thread (`thread_id`); the card's facts
 * come from here, never the caller: `their_message` (quotes trimmed),
 * `lead_name` / `company` (CRM deal, else lead bank). An outbound email is
 * refused (`not_an_inbound_email`), and so is one with no receiving inbox
 * (`no_eaccount`). The email's `campaign_id` replaces the caller's.
 * It sets `campaign_verified: true` only then (server-only; the Auto-mode
 * grant requires it). `reply_to_uuid` is lowercased. The caller's judgment fields (verdict,
 * proposed_times, research_note) pass through. Edit fields are dropped (only
 * the decide route's Edit writes them), and so is `drafted_by_operator`
 * (the caller of the builder sets it from who is asking). Shape errors are left for
 * `parseCampaignPayload`.
 */
const CARD_FACTS = ['their_message', 'lead_name', 'company', 'thread_id', 'original_body', 'edited_by', 'edited_at', 'drafted_by_operator'] as const

async function withServerExtras(kind: CampaignActionKind, raw: Record<string, unknown>): Promise<{ payload: Record<string, unknown> } | { error: string }> {
  const p: Record<string, unknown> = { ...raw }
  delete p.campaign_name
  delete p.source_name
  delete p.recipient_verified
  delete p.campaign_verified
  if (kind === 'send_reply') {
    for (const k of CARD_FACTS) delete p[k]
    const claimed = text(p.lead_email) ?? text(p.to)
    delete p.lead_email
    delete p.to
    const replyTo = text(p.reply_to_uuid)?.toLowerCase() ?? null
    if (replyTo) p.reply_to_uuid = replyTo
    const email = replyTo ? await liveEmail(replyTo) : null
    if (email && email.direction !== 'in') return { error: 'not_an_inbound_email' }
    if (email && !email.eaccount) return { error: 'no_eaccount' }
    if (email?.lead) {
      p.lead_email = email.lead
      p.recipient_verified = true
      p.eaccount = email.eaccount
      // The email's own campaign, never the caller's: routing and scope follow it.
      // campaign_verified (server-only): the campaign came from the email itself; the Auto grant requires it.
      if (email.campaign_id) {
        p.campaign_id = email.campaign_id
        p.campaign_verified = true
      }
      p.thread_id = email.thread_id
      const said = trimQuotes(email.text)
      if (said) p.their_message = said.length > 2000 ? `${said.slice(0, 1999)}…` : said
      if (!text(p.subject) && email.subject) p.subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`
      const campaign = text(p.campaign_id)
      if (campaign) Object.assign(p, await leadCard(campaign, email.lead))
    } else {
      const found = replyTo ? await replyRecipient(replyTo) : null
      if (found) {
        p.lead_email = found.lead
        p.recipient_verified = true
        if (!text(p.campaign_id) && found.campaign_id) p.campaign_id = found.campaign_id
      } else {
        if (claimed) p.lead_email = claimed
        p.recipient_verified = false
      }
    }
  }
  const id = text(kind === 'create_campaign' ? p.source_campaign_id : p.campaign_id)
  if (id) p.campaign_name = await campaignName(id)
  return { payload: p }
}

/** The email being answered, from Instantly (cached); null when unknown or unreachable. */
async function liveEmail(id: string): Promise<InboxEmail | null> {
  if (!isInstantlyConfigured()) return null
  try {
    return await getEmail(id)
  } catch (err) {
    console.error('[actions/build] Instantly email read failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Name and company for the reply card: the CRM deal, else the lead bank; omitted when unknown. */
async function leadCard(campaignId: string, email: string): Promise<{ lead_name?: string; company?: string }> {
  try {
    const deal = await findDeal(campaignId, email)
    let name = deal?.name ?? null
    let company = deal?.company ?? null
    if (!name || !company) {
      const lead = await findLeadByEmail(campaignId, email)
      name = name ?? ([lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || null)
      company = company ?? lead?.company_name ?? null
    }
    return { ...(name ? { lead_name: name } : {}), ...(company ? { company } : {}) }
  } catch (err) {
    console.error('[actions/build] lead card lookup failed:', err instanceof Error ? err.message : err)
    return {}
  }
}

/**
 * label_reply (a blocking label the agent asked for: unsubscribe, hostile,
 * BAD + block): the label as validated by the inbox schema, plus the lead
 * and campaign from the email for the card and routing. The executor applies
 * it with lib/inbox/label.ts after approval.
 */
async function buildLabelReply(raw: Record<string, unknown>): Promise<ActionBuild> {
  const parsed = LabelBody.safeParse({ ...raw, ...(typeof raw.reply_to_uuid === 'string' ? { reply_to_uuid: raw.reply_to_uuid.toLowerCase() } : {}) })
  if (!parsed.success) return fail(400, 'invalid_payload')
  const input = parsed.data
  const payload: Record<string, Json> = {}
  for (const [k, v] of Object.entries(input)) if (v !== undefined) payload[k] = v as Json
  if (input.reply_to_uuid) {
    const email = await liveEmail(input.reply_to_uuid)
    if (email?.lead) payload.lead_email = email.lead
    if (email?.campaign_id) payload.campaign_id = email.campaign_id
  }
  const plan = labelPlan(input)
  const label = input.category ?? 'bad fit (BAD)'
  const who = typeof payload.lead_email === 'string' ? payload.lead_email : (input.reply_to_uuid ?? 'lead')
  const summary = `Label ${who} as ${label.replace(/_/g, ' ')}${plan.block ? ' and add the address to the Instantly blocklist' : ''}${input.note ? `: ${input.note}` : ''}`
  return { ok: true, kind: 'label_reply', payload: { ...payload, summary } }
}
