import 'server-only'
import { createAction, DuplicateActionError } from '@/lib/actions/create'
import { recoverInterruptedActions, sweepStuckActions } from '@/lib/actions/execute'
import { editMessage, sendMessage } from '@/lib/adapters/telegram'
import {
  claimRule,
  countCandidates,
  expireStaleActions,
  findAwaitingRuleAction,
  getCampaignByExternalId,
  getDueRules,
  logEvent,
  setRuleResult,
  type DueRule,
} from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { parseRuleFilter, summarizeFilter } from '@/lib/rules/filter'
import { nextRun } from '@/lib/rules/nextRun'

/**
 * The rotation tick (`POST /api/cron/rotation-tick`, called by pg_cron's
 * `lume_rotation_tick()`). Notify-only, like the watchdog: it never writes
 * lead_bank and never calls Instantly. For each due rule it creates at most
 * one `pending_actions(kind='assign_leads')` + Telegram prompt; the owner's
 * tap runs it (Task 12's executor).
 *
 * Idempotency, in order:
 *  1. claim by advancing — `claimRule` is one conditional UPDATE of
 *     next_run_at/last_run_at; a second tick racing for the same rule gets
 *     zero rows and skips;
 *  2. an awaiting assign_leads with this rule_id → skip (a confirmation is
 *     still open; don't stack another);
 *  3. the unique index `pending_actions_one_awaiting_rule_idx` backs (2):
 *     a 23505 surfaces as DuplicateActionError → skipped.
 * Failures write `last_result.error` and ping Telegram; the claim already
 * advanced the rule, so there is no retry until its next scheduled run.
 *
 * Before the rules, awaiting actions older than 24 h expire. After them, the
 * sweeper re-dispatches approved actions nobody ran (`executed_at` null,
 * decided over 2 min ago — the Telegram path's `waitUntil` can be cut) to
 * `/api/actions/<id>/execute` at `origin`, without waiting for them to finish
 * (the execute route's claim makes that idempotent), and rows stuck in
 * `executing` for 10 min are failed as `interrupted` (never re-run). This
 * route never runs an action inline.
 */

export const ACTION_TTL_MS = 24 * 3600_000
const BAD_CRON_RETRY_MS = 24 * 3600_000

export type RuleOutcome =
  | { rule_id: string; outcome: 'created'; action_id: string; count: number; available: number }
  | { rule_id: string; outcome: 'skipped'; reason: 'claimed_elsewhere' | 'action_awaiting' | 'no_candidates'; action_id?: string }
  | { rule_id: string; outcome: 'error'; error: string }

export interface TickResult {
  ok: boolean
  expired: number
  rules: RuleOutcome[]
  /** Approved-but-unexecuted actions the sweeper re-dispatched. */
  swept: { id: string; status: string }[]
  /** `executing` rows cut mid-run, now `failed` (interrupted). */
  interrupted: string[]
  errors: string[]
}

const fmt = new Intl.NumberFormat('en-US')
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

export async function runRotationTick(now: Date, origin: string): Promise<TickResult> {
  const errors: string[] = []
  let expired = 0
  try {
    expired = await expireActions(now)
  } catch (err) {
    errors.push(`expire: ${msg(err)}`)
    console.error('[rotation-tick] expire failed:', msg(err))
  }

  const rules: RuleOutcome[] = []
  try {
    for (const rule of await getDueRules(now.toISOString())) rules.push(await runRule(rule, now))
  } catch (err) {
    errors.push(`rules: ${msg(err)}`)
    console.error('[rotation-tick] rules failed:', msg(err))
  }

  const swept: TickResult['swept'] = []
  try {
    for (const s of await sweepStuckActions(now, origin)) {
      swept.push({ id: s.id, status: s.outcome === 'dispatched' ? 'dispatched' : `error: ${s.outcome.error}` })
    }
  } catch (err) {
    errors.push(`sweep: ${msg(err)}`)
    console.error('[rotation-tick] sweep failed:', msg(err))
  }

  let interrupted: string[] = []
  try {
    interrupted = await recoverInterruptedActions(now)
  } catch (err) {
    errors.push(`interrupted: ${msg(err)}`)
    console.error('[rotation-tick] interrupted recovery failed:', msg(err))
  }
  return { ok: errors.length === 0, expired, rules, swept, interrupted, errors }
}

async function expireActions(now: Date): Promise<number> {
  const rows = await expireStaleActions(new Date(now.getTime() - ACTION_TTL_MS).toISOString())
  for (const r of rows) {
    const summary = typeof r.payload?.summary === 'string' && r.payload.summary ? r.payload.summary : r.kind
    if (r.telegram_message_id !== null) {
      // Strip the buttons; a late tap would only find nothing to claim.
      await editMessage(r.telegram_message_id, `⌛ Expired (no decision in 24 h)\n${r.kind}: ${summary}`).catch(() => null)
    }
    await logEvent({
      type: 'lume.action_expired',
      source: 'lume',
      source_id: r.id,
      title: `Expired · ${r.kind}`,
      payload: { kind: r.kind },
    }).catch((err) => console.error('[rotation-tick] logEvent failed:', msg(err)))
  }
  return rows.length
}

async function runRule(rule: DueRule, now: Date): Promise<RuleOutcome> {
  const nowIso = now.toISOString()
  const next = nextRun(rule.cron, now)

  // 1. Claim first. A cron that no longer parses is pushed a day out so it
  // cannot fire every 15 minutes, and reported.
  let claimed: boolean
  try {
    claimed = await claimRule(rule.id, next ?? new Date(now.getTime() + BAD_CRON_RETRY_MS).toISOString(), nowIso)
  } catch (err) {
    // Nothing claimed: no last_result write (it would race the winner); the
    // next tick retries.
    return { rule_id: rule.id, outcome: 'error', error: msg(err) }
  }
  if (!claimed) return { rule_id: rule.id, outcome: 'skipped', reason: 'claimed_elsewhere' }

  try {
    if (!next) throw new Error(`invalid cron expression "${rule.cron}"`)

    // 2. A confirmation for this rule is still open.
    const open = await findAwaitingRuleAction('assign_leads', rule.id)
    if (open) {
      await setRuleResult(rule.id, { at: nowIso, skipped: 'action_awaiting', action_id: open.id })
      return { rule_id: rule.id, outcome: 'skipped', reason: 'action_awaiting', action_id: open.id }
    }

    const filter = parseRuleFilter(rule.filter)
    const available = await countCandidates(filter, rule.campaign_id)
    if (available === 0) {
      await setRuleResult(rule.id, { at: nowIso, count: 0, skipped: 'no_candidates' })
      return { rule_id: rule.id, outcome: 'skipped', reason: 'no_candidates' }
    }
    const count = Math.min(available, rule.daily_cap)
    const campaign = await getCampaignByExternalId(rule.campaign_id).catch(() => null)
    const campaignName = campaign?.name ?? rule.campaign_id

    let action
    try {
      action = await createAction(
        'assign_leads',
        {
          campaign_id: rule.campaign_id,
          campaign_name: campaignName,
          filter: filter as Record<string, Json>,
          order_by: rule.order_by,
          count,
          available,
          daily_cap: rule.daily_cap,
          rule_id: rule.id,
          rule_name: rule.name,
          summary:
            `Assign ${fmt.format(count)} leads → ${campaignName} ` +
            `(rule "${rule.name}": ${summarizeFilter(filter)}, ${rule.order_by} first; ${fmt.format(available)} available)`,
        },
        'rule',
        { ruleId: rule.id }
      )
    } catch (err) {
      if (err instanceof DuplicateActionError) {
        await setRuleResult(rule.id, { at: nowIso, skipped: 'action_awaiting', action_id: err.existingId || null })
        return { rule_id: rule.id, outcome: 'skipped', reason: 'action_awaiting', ...(err.existingId ? { action_id: err.existingId } : {}) }
      }
      throw err
    }

    await setRuleResult(rule.id, { at: nowIso, action_id: action.id, count, available })
    await logEvent({
      type: 'lume.rule_fired',
      source: 'lume',
      source_id: rule.id,
      campaign_id: rule.campaign_id,
      title: `Rule "${rule.name}" → ${fmt.format(count)} leads awaiting confirmation`,
      payload: { action_id: action.id, count, available },
    }).catch((err) => console.error('[rotation-tick] logEvent failed:', msg(err)))
    return { rule_id: rule.id, outcome: 'created', action_id: action.id, count, available }
  } catch (err) {
    const error = msg(err)
    console.error(`[rotation-tick] rule ${rule.id} failed:`, error)
    await setRuleResult(rule.id, { at: nowIso, error }).catch(() => null)
    await sendMessage(`⚠️ Rotation rule "${rule.name}" failed: ${error}\nNothing was assigned.`).catch(() => null)
    return { rule_id: rule.id, outcome: 'error', error }
  }
}
