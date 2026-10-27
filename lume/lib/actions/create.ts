import 'server-only'
import { findAwaitingAction, findAwaitingRuleAction, insertPendingAction, isDbError, setActionMessageId } from '@/lib/db/service'
import { sendActionPrompt } from '@/lib/adapters/telegram'
import { buildActionPrompt } from '@/lib/adapters/telegram.messages'
import { alert, alertLink, gateKey, telegramSkipped, titleFrom } from '@/lib/alerts'
import { routeItemForAction } from '@/lib/operators/route'
import { CAMPAIGN_ACTION_KEY, isCampaignActionKind, parseCampaignPayload } from '@/lib/actions/payloads'
import { findAwaitingActionBy } from '@/lib/campaigns/service'
import type { Json, PendingActionKind, PendingActionRow } from '@/lib/db/types'
import { CRM_CLOSE_KIND, parseCrmClosePayload } from '@/lib/crm/actions'
import { updateSequencePayloadError } from '@/lib/campaigns/sequenceAction'
import { removeLeadsPayloadError } from '@/lib/actions/removeLeadsPayload'

/**
 * Create a high-risk `pending_actions` row and ask for confirmation in
 * Telegram (`lume_ok` / `lume_no` + a `/actions/<id>` deep link). This is
 * only the request; `lib/actions/execute.ts` runs it after a decision.
 *
 * Every payload carries a human `summary`. Every action about a validation
 * job (`push_to_instantly`, `launch_campaign`, and any other kind that names
 * one) carries `job_id` (lowercase uuid, as the DB prints it — the
 * `lume_gates` push_review anti-join compares `payload->>'job_id'` to
 * `id::text`); for the job kinds it is required. A second awaiting action of
 * the same kind for the same job is refused with `DuplicateActionError` —
 * checked first, and backed by the unique partial index
 * `pending_actions_one_awaiting_idx` (23505 → the same error).
 *
 * Rule kinds (`activate_rule`, `delete_rule`, and `assign_leads` from a rule)
 * pass `meta.ruleId`; the duplicate check is then per (kind, rule), backed by
 * `pending_actions_one_awaiting_rule_idx`. `assign_leads` needs
 * `payload.campaign_id`. A drag assignment (no rule) is not deduplicated:
 * executing it twice is a no-op on `unique(campaign_id, email)`.
 *
 * Campaign kinds (`send_reply`, `pause_campaign`, `resume_campaign`,
 * `create_campaign`): the payload is validated (and cleaned, `summary` filled
 * when absent) by `parseCampaignPayload` in `lib/actions/payloads.ts` — the
 * same validator the API route uses. One awaiting action per kind and
 * `CAMPAIGN_ACTION_KEY` value (pause/resume per campaign, send_reply per
 * reply_to_uuid, create_campaign per source campaign); pause/resume and
 * send_reply are backed by the partial unique indexes from migration
 * `lume_pending_actions_campaign_unique` (23505 → the same error).
 *
 * `run_actor` (an Apify actor run): the snapshot from `buildActionRequest`
 * (validated input + capped options); one awaiting per `input_hash`, backed
 * by `pending_actions_one_awaiting_run_actor_idx`.
 *
 * `update_sequence` (edit a live campaign's emails): one awaiting edit per
 * campaign, backed by `pending_actions_one_awaiting_sequence_idx`.
 *
 * Telegram unconfigured: the row is still created; the prompt is skipped
 * (the adapter logs it) and `telegram_message_id` stays null.
 */

/** Kinds that are always about one validation job. */
export const JOB_KINDS: ReadonlySet<PendingActionKind> = new Set<PendingActionKind>(['push_to_instantly', 'launch_campaign'])

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Kinds that must name their rule (`meta.ruleId`). */
const RULE_KINDS: ReadonlySet<PendingActionKind> = new Set<PendingActionKind>(['activate_rule', 'delete_rule'])

export class DuplicateActionError extends Error {
  readonly existingId: string
  constructor(existingId: string) {
    super('an awaiting action of this kind already exists for this target')
    this.name = 'DuplicateActionError'
    this.existingId = existingId
  }
}

export class InvalidActionPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidActionPayloadError'
  }
}

const isObj = (v: Json | undefined) => !!v && typeof v === 'object' && !Array.isArray(v)

/** A `run_actor` snapshot must carry what the executor and the card read (lib/apify/service.ts runActorPayload). */
function runActorPayloadError(p: Record<string, Json>): string | null {
  if (typeof p.actor_id !== 'string' || !p.actor_id) return 'payload.actor_id is required'
  if (!isObj(p.input)) return 'payload.input must be an object'
  const o = p.options as Record<string, Json> | null
  if (!isObj(o) || typeof o!.maxTotalChargeUsd !== 'number' || typeof o!.timeout !== 'number') return 'payload.options needs maxTotalChargeUsd and timeout'
  if (typeof p.cap_usd !== 'number' || (o!.maxTotalChargeUsd as number) > p.cap_usd) return 'payload.options exceed the cap'
  if (typeof p.input_hash !== 'string' || !/^[0-9a-f]{32}$/.test(p.input_hash)) return 'payload.input_hash is required'
  return null
}

export interface CreateActionMeta {
  agentRunId?: string | null
  ruleId?: string | null
}

export async function createAction(
  kind: PendingActionKind,
  payload: Record<string, Json>,
  requestedBy: PendingActionRow['requested_by'],
  meta: CreateActionMeta = {}
): Promise<PendingActionRow> {
  const ruleId = meta.ruleId ?? null
  let campaignKey: { field: string; value: string } | null = null
  if (isCampaignActionKind(kind)) {
    const parsed = parseCampaignPayload(kind, payload)
    if (!parsed.ok) throw new InvalidActionPayloadError(parsed.error)
    payload = parsed.payload
    const field = CAMPAIGN_ACTION_KEY[kind]
    campaignKey = { field, value: String(payload[field]) }
  } else if (kind === CRM_CLOSE_KIND) {
    // One awaiting close per deal (pending_actions_one_awaiting_deal_idx).
    const parsed = parseCrmClosePayload(payload)
    if (!parsed.ok) throw new InvalidActionPayloadError(parsed.error)
    payload = parsed.payload
    campaignKey = { field: 'deal_id', value: String(payload.deal_id) }
  } else if (kind === 'run_actor') {
    // One awaiting run per identical request (pending_actions_one_awaiting_run_actor_idx).
    const err = runActorPayloadError(payload)
    if (err) throw new InvalidActionPayloadError(err)
    campaignKey = { field: 'input_hash', value: String(payload.input_hash) }
  } else if (kind === 'issue_operator_key') {
    // One awaiting key request per vertical (pending_actions_one_awaiting_operator_key_idx).
    if (typeof payload.vertical_id !== 'string' || !LOWER_UUID.test(payload.vertical_id)) {
      throw new InvalidActionPayloadError('payload.vertical_id must be a lowercase uuid')
    }
    campaignKey = { field: 'vertical_id', value: payload.vertical_id }
  } else if (kind === 'remove_leads') {
    // One awaiting agent/user removal per campaign (pending_actions_one_awaiting_remove_leads_idx);
    // a cycle-out rule's removal is one-per-rule instead (meta.ruleId).
    const err = removeLeadsPayloadError(payload)
    if (err) throw new InvalidActionPayloadError(err)
    campaignKey = { field: 'campaign_id', value: String(payload.campaign_id) }
  } else if (kind === 'update_sequence') {
    const err = updateSequencePayloadError(payload)
    if (err) throw new InvalidActionPayloadError(err)
    campaignKey = { field: 'campaign_id', value: String(payload.campaign_id) }
  }
  const rawJobId = payload.job_id
  if (rawJobId === undefined && JOB_KINDS.has(kind)) {
    throw new InvalidActionPayloadError('payload.job_id must be a lowercase uuid')
  }
  if (rawJobId !== undefined && (typeof rawJobId !== 'string' || !LOWER_UUID.test(rawJobId))) {
    throw new InvalidActionPayloadError('payload.job_id must be a lowercase uuid')
  }
  const jobId: string | null = typeof rawJobId === 'string' ? rawJobId : null
  if (kind === 'assign_leads' && (typeof payload.campaign_id !== 'string' || !payload.campaign_id.trim())) {
    throw new InvalidActionPayloadError('payload.campaign_id is required')
  }
  if (RULE_KINDS.has(kind) && (!ruleId || !LOWER_UUID.test(ruleId))) {
    throw new InvalidActionPayloadError(`${kind} needs meta.ruleId (lowercase uuid)`)
  }
  if (typeof payload.summary !== 'string' || !payload.summary.trim()) {
    throw new InvalidActionPayloadError('payload.summary is required')
  }

  const findExisting = () =>
    jobId
      ? findAwaitingAction(kind, jobId)
      : ruleId
        ? findAwaitingRuleAction(kind, ruleId)
        : campaignKey
          ? findAwaitingActionBy(kind, campaignKey.field, campaignKey.value)
          : Promise.resolve(null)

  const existing = await findExisting()
  if (existing) throw new DuplicateActionError(existing.id)

  let row: PendingActionRow
  try {
    row = await insertPendingAction({
      kind,
      payload,
      requested_by: requestedBy,
      agent_run_id: meta.agentRunId ?? null,
      rule_id: ruleId,
    })
  } catch (err) {
    // pending_actions_one_awaiting_idx / _rule_idx / the campaign indexes: a concurrent request won the race.
    if (isDbError(err) && err.code === '23505') {
      const winner = await findExisting().catch(() => null)
      throw new DuplicateActionError(winner?.id ?? '')
    }
    throw err
  }

  // The approval ping: always in the feed (one row per action), and the same
  // Telegram prompt as before while ALERT_CHANNELS includes telegram.
  const promptText = buildActionPrompt(row).text
  const route = routeItemForAction(row)
  const sent = (await alert({
    source: 'lume.actions', severity: 'urgent', title: titleFrom(promptText), body: promptText,
    link: alertLink(`/actions/${row.id}`), campaign_id: route.campaign_id, scope: route.scope, owner_only: route.owner_only,
    dedupe_key: gateKey(row.id, 'lume_action'),
    telegram: () => sendActionPrompt(row),
  })) ?? telegramSkipped
  if (sent.ok && sent.messageId !== null) {
    try {
      await setActionMessageId(row.id, sent.messageId)
      return { ...row, telegram_message_id: sent.messageId }
    } catch (err) {
      // The action exists and the prompt went out; a missing message id only
      // means the Telegram message is not edited on decision.
      console.error('[actions] could not store telegram_message_id:', err instanceof Error ? err.message : err)
    }
  }
  return row
}
