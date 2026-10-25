import 'server-only'
import { findAwaitingAction, findAwaitingRuleAction, insertPendingAction, isDbError, setActionMessageId } from '@/lib/db/service'
import { sendActionPrompt } from '@/lib/adapters/telegram'
import type { Json, PendingActionKind, PendingActionRow } from '@/lib/db/types'

/**
 * Create a high-risk `pending_actions` row and ask for confirmation in
 * Telegram (`lume_ok` / `lume_no` + a `/actions/<id>` deep link). Task 12
 * builds the decide/execute side; this is only the request.
 *
 * Every payload carries a human `summary`. Job-scoped kinds (everything but
 * the Rotate kinds) carry `job_id` (lowercase uuid, as the DB prints it — the
 * `lume_gates` push_review anti-join compares `payload->>'job_id'` to
 * `id::text`). A second awaiting action of the same kind for the same job is
 * refused with `DuplicateActionError` — checked first, and backed by the
 * unique partial index `pending_actions_one_awaiting_idx` (23505 → the same
 * error).
 *
 * Rotate kinds are not about a job: `assign_leads` carries `campaign_id`
 * (and, from a rule, `meta.ruleId`); `activate_rule` needs `meta.ruleId`.
 * With a rule id the duplicate check is per (kind, rule), backed by
 * `pending_actions_one_awaiting_rule_idx`. A drag assignment (no rule) is not
 * deduplicated: executing it twice is a no-op on `unique(campaign_id, email)`.
 *
 * Telegram unconfigured: the row is still created; the prompt is skipped
 * (the adapter logs it) and `telegram_message_id` stays null.
 */

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Kinds that are not about a validation job. */
const JOB_FREE_KINDS: ReadonlySet<PendingActionKind> = new Set<PendingActionKind>(['assign_leads', 'activate_rule'])

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
  let jobId: string | null = null
  if (JOB_FREE_KINDS.has(kind)) {
    if (kind === 'assign_leads' && (typeof payload.campaign_id !== 'string' || !payload.campaign_id.trim())) {
      throw new InvalidActionPayloadError('payload.campaign_id is required')
    }
    if (kind === 'activate_rule' && (!ruleId || !LOWER_UUID.test(ruleId))) {
      throw new InvalidActionPayloadError('activate_rule needs meta.ruleId (lowercase uuid)')
    }
  } else {
    if (typeof payload.job_id !== 'string' || !LOWER_UUID.test(payload.job_id)) {
      throw new InvalidActionPayloadError('payload.job_id must be a lowercase uuid')
    }
    jobId = payload.job_id
  }
  if (typeof payload.summary !== 'string' || !payload.summary.trim()) {
    throw new InvalidActionPayloadError('payload.summary is required')
  }

  const findExisting = () =>
    jobId ? findAwaitingAction(kind, jobId) : ruleId ? findAwaitingRuleAction(kind, ruleId) : Promise.resolve(null)

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
    // pending_actions_one_awaiting_idx / _rule_idx: a concurrent request won the race.
    if (isDbError(err) && err.code === '23505') {
      const winner = await findExisting().catch(() => null)
      throw new DuplicateActionError(winner?.id ?? '')
    }
    throw err
  }

  const sent = await sendActionPrompt(row)
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
