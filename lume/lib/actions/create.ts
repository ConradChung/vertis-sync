import 'server-only'
import { findAwaitingAction, insertPendingAction, isDbError, setActionMessageId } from '@/lib/db/service'
import { sendActionPrompt } from '@/lib/adapters/telegram'
import type { Json, PendingActionKind, PendingActionRow } from '@/lib/db/types'

/**
 * Create a high-risk `pending_actions` row and ask for confirmation in
 * Telegram (`lume_ok` / `lume_no` + a `/actions/<id>` deep link). Task 12
 * builds the decide/execute side; this is only the request.
 *
 * The payload must carry `job_id` (lowercase uuid, as the DB prints it — the
 * `lume_gates` push_review anti-join compares `payload->>'job_id'` to
 * `id::text`) and a human `summary`. A second awaiting action of the same
 * kind for the same job is refused with `DuplicateActionError` — checked
 * first, and backed by the unique partial index
 * `pending_actions_one_awaiting_idx` (23505 → the same error).
 *
 * Telegram unconfigured: the row is still created; the prompt is skipped
 * (the adapter logs it) and `telegram_message_id` stays null.
 */

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class DuplicateActionError extends Error {
  readonly existingId: string
  constructor(existingId: string) {
    super('an awaiting action of this kind already exists for this job')
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
  const jobId = payload.job_id
  if (typeof jobId !== 'string' || !LOWER_UUID.test(jobId)) {
    throw new InvalidActionPayloadError('payload.job_id must be a lowercase uuid')
  }
  if (typeof payload.summary !== 'string' || !payload.summary.trim()) {
    throw new InvalidActionPayloadError('payload.summary is required')
  }

  const existing = await findAwaitingAction(kind, jobId)
  if (existing) throw new DuplicateActionError(existing.id)

  let row: PendingActionRow
  try {
    row = await insertPendingAction({
      kind,
      payload,
      requested_by: requestedBy,
      agent_run_id: meta.agentRunId ?? null,
      rule_id: meta.ruleId ?? null,
    })
  } catch (err) {
    // pending_actions_one_awaiting_idx: a concurrent request won the race.
    if (isDbError(err) && err.code === '23505') {
      const winner = await findAwaitingAction(kind, jobId).catch(() => null)
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
