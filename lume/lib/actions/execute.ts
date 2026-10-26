import 'server-only'
import { decide, type DecideResult } from '@/lib/adapters/pipeline'
import {
  createCampaignFrom,
  getCampaignDetail,
  pauseCampaign,
  resumeCampaign,
  sendReply,
} from '@/lib/adapters/instantlyWrite'
import { sendMessage } from '@/lib/adapters/telegram'
import { actionLink } from '@/lib/adapters/telegram.messages'
import { getPushJob, logEvent } from '@/lib/db/service'
import { getDeal, setStage } from '@/lib/crm/service'
import { startRun } from '@/lib/adapters/apify'
import { getSequenceFresh, patchSequence } from '@/lib/adapters/instantlySequences'
import type { InstantlyStep } from '@/lib/campaigns/sequence'
import { checkRunActor, tightenOptions } from '@/lib/apify/service'
import type { RunOptions } from '@/lib/apify/pricing'
import type { Json, PendingActionRow } from '@/lib/db/types'
import { nextRun } from '@/lib/rules/nextRun'
import { parseRuleFilter } from '@/lib/rules/filter'
import {
  activateRule,
  claimExecution,
  deleteRule,
  failInterruptedActions,
  finishAction,
  getAction,
  getRule,
  getStaleApprovedIds,
  insertQueuedLeads,
  resolveLeadsByFilter,
  resolveLeadsByRefs,
  type LeadBankInsert,
  type LeadBankRef,
} from '@/lib/actions/store'

/**
 * The one executor for a `pending_actions` row, whoever approved it: a Lume
 * click (decide route), a Telegram tap (telegram-inbox → execute route) or the
 * sweeper. It first claims `approved + claimed + executed_at is null →
 * executing`; a lost claim is a no-op, so a double tap or a retry never runs
 * anything twice. Then it dispatches on `kind`, records `executed` / `failed`
 * with `result` and `executed_at`, and posts the outcome to Telegram.
 *
 * Nothing else in Lume may call Instantly's write side or `pipeline.decide()`
 * for these steps.
 */

export type ExecuteOutcome =
  | { ran: false; reason: 'not_found' | 'not_claimable'; status?: PendingActionRow['status'] }
  | { ran: true; status: 'executed' | 'failed'; result: Record<string, Json>; error: string | null }

class ActionFailure extends Error {
  readonly result: Record<string, Json>
  constructor(message: string, result: Record<string, Json> = {}) {
    super(message)
    this.name = 'ActionFailure'
    this.result = result
  }
}

const str = (v: Json | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
function need(p: Record<string, Json>, key: string): string {
  const v = str(p[key])
  if (!v) throw new ActionFailure(`payload.${key} is missing`)
  return v
}

/** pipeline.decide → result, or throw. A timeout is "sent, outcome unknown", not a failure. */
async function runDecide(callbackData: string): Promise<Record<string, Json>> {
  const r: DecideResult = await decide(callbackData)
  if (r.ok) {
    if (r.claimed === false) throw new ActionFailure('gate already handled elsewhere', { callback_data: callbackData, claimed: false })
    return { callback_data: callbackData, claimed: r.claimed }
  }
  if (r.error === 'timeout') return { callback_data: callbackData, claimed: null, timeout: true }
  throw new ActionFailure(`pipeline: ${r.error}`, { callback_data: callbackData, http_status: r.status })
}

type Handler = (p: Record<string, Json>, action: PendingActionRow) => Promise<Record<string, Json>>

const HANDLERS: Record<PendingActionRow['kind'], Handler> = {
  async push_to_instantly(p) {
    const jobId = need(p, 'job_id')
    const job = await getPushJob(jobId)
    if (!job) throw new ActionFailure('job not found')
    // What runs must be what the owner confirmed (same defaults as /api/actions).
    const now = {
      campaign_id: job.instantly_campaign_id,
      location_barrier: job.location_barrier ?? false,
      company_barrier: job.company_barrier ?? true,
      company_strict: job.company_strict ?? false,
    }
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter((k) => now[k] !== p[k])
    if (changed.length) {
      throw new ActionFailure(`push settings changed since confirmation: ${changed.join(', ')}`, { changed, current: now })
    }
    return runDecide(`push_go:${jobId}`)
  },

  async launch_campaign(p) {
    const jobId = need(p, 'job_id')
    const out = await runDecide(`camp_launch:${jobId}`)
    const campaignId = str(p.campaign_id)
    if (campaignId) {
      try {
        const c = await getCampaignDetail(campaignId)
        out.instantly_status = typeof c.status === 'number' ? c.status : null
      } catch (err) {
        out.status_error = err instanceof Error ? err.message : String(err)
      }
    }
    return out
  },

  async decide_gate(p) {
    return runDecide(need(p, 'callback_data'))
  },

  /**
   * One payload shape (lib/rules/actions.ts, lib/rules/tick.ts):
   * `{ campaign_id, count, summary, … }` plus either `leads: [{origin, id}]`
   * (a drag of selected rows) or `filter` (+ `order_by`; a drag of "all N
   * matching" or a rule run). Both resolve against `lume_lead_bank` now, not at
   * confirmation, skipping leads already queued for the campaign; a filter
   * takes at most the confirmed `count`. Inserts are `on conflict
   * (campaign_id, email) do nothing`.
   */
  async assign_leads(p): Promise<Record<string, Json>> {
    const campaignId = need(p, 'campaign_id')
    let rows: LeadBankInsert[]
    let mode: 'leads' | 'filter'
    if (Array.isArray(p.leads)) {
      mode = 'leads'
      const refs: LeadBankRef[] = []
      for (const l of p.leads) {
        if (!l || typeof l !== 'object' || Array.isArray(l)) continue
        const origin = (l as Record<string, Json>).origin
        const id = str((l as Record<string, Json>).id)
        if ((origin === 'lead_bank' || origin === 'validation_rows') && id) refs.push({ origin, id })
      }
      if (!refs.length) throw new ActionFailure('payload.leads has no lead references')
      rows = await resolveLeadsByRefs(refs, campaignId)
    } else if (p.filter && typeof p.filter === 'object' && !Array.isArray(p.filter)) {
      mode = 'filter'
      const count = typeof p.count === 'number' && Number.isFinite(p.count) ? Math.floor(p.count) : 0
      if (count < 1) throw new ActionFailure('payload.count is missing')
      const orderBy = p.order_by === 'oldest' ? 'oldest' : 'newest'
      rows = await resolveLeadsByFilter(parseRuleFilter(p.filter), campaignId, count, orderBy)
    } else {
      throw new ActionFailure('payload needs leads or filter')
    }
    if (!rows.length) {
      return { campaign_id: campaignId, mode, requested: 0, inserted: 0, skipped: 0, note: 'nothing left to assign' }
    }
    const inserted = await insertQueuedLeads(rows)
    return { campaign_id: campaignId, mode, requested: rows.length, inserted, skipped: rows.length - inserted }
  },

  async activate_rule(p, action) {
    const ruleId = str(p.rule_id) ?? action.rule_id
    if (!ruleId) throw new ActionFailure('payload.rule_id is missing')
    const rule = await getRule(ruleId)
    if (!rule) throw new ActionFailure('rule not found')
    const next = nextRun(rule.cron)
    if (!next) throw new ActionFailure(`rule cron does not parse: ${rule.cron}`)
    if (!(await activateRule(ruleId, next))) throw new ActionFailure('rule not found')
    return { rule_id: ruleId, active: true, next_run_at: next }
  },

  async delete_rule(p, action) {
    const ruleId = str(p.rule_id) ?? action.rule_id
    if (!ruleId) throw new ActionFailure('payload.rule_id is missing')
    const deleted = await deleteRule(ruleId)
    if (!deleted) throw new ActionFailure('rule not found')
    return { rule_id: ruleId, deleted: true }
  },

  async send_reply(p) {
    const sent = await sendReply({
      eaccount: need(p, 'eaccount'),
      reply_to_uuid: need(p, 'reply_to_uuid'),
      subject: str(p.subject) ?? 'Re:',
      body: need(p, 'body'),
    })
    return { reply_to_uuid: need(p, 'reply_to_uuid'), email_id: sent.id ?? null }
  },

  async pause_campaign(p) {
    const id = need(p, 'campaign_id')
    await pauseCampaign(id)
    return { campaign_id: id, paused: true }
  },

  async resume_campaign(p) {
    const id = need(p, 'campaign_id')
    await resumeCampaign(id)
    return { campaign_id: id, resumed: true }
  },

  /** Won/Lost, confirmed: apply with crm_set_stage() (stage + reason + activity). */
  async crm_close_deal(p) {
    const dealId = need(p, 'deal_id')
    const stage = need(p, 'stage')
    if (stage !== 'Won' && stage !== 'Lost') throw new ActionFailure(`not a closing stage: ${stage}`)
    const deal = await getDeal(dealId)
    if (!deal) throw new ActionFailure('deal not found')
    const from = await setStage(dealId, stage, 'user', str(p.reason), { via: 'pending_action' })
    if (from === null) throw new ActionFailure('deal not found')
    return { deal_id: dealId, from, to: stage }
  },

  /**
   * Start the Apify run the owner confirmed. Re-checks first (actor still
   * there, input still valid against its schema, pricing still cappable) and
   * starts with options never looser than the confirmed ones, so the $20 cap
   * holds even if the actor's pricing changed in between. Apify enforces the
   * limits on the run itself; results are imported separately (Import gate).
   */
  async run_actor(p) {
    const actorId = need(p, 'actor_id')
    const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? (p.input as Record<string, unknown>) : null
    const confirmed = p.options as unknown as RunOptions | null
    if (!input) throw new ActionFailure('payload.input is missing')
    if (!confirmed || typeof confirmed.maxTotalChargeUsd !== 'number' || typeof confirmed.timeout !== 'number') {
      throw new ActionFailure('payload.options is missing')
    }
    const cap = typeof p.cap_usd === 'number' ? p.cap_usd : 0
    if (!(confirmed.maxTotalChargeUsd > 0) || confirmed.maxTotalChargeUsd > cap) throw new ActionFailure('confirmed budget exceeds the cap')
    const check = await checkRunActor({
      actor_id: actorId,
      input,
      max_charge_usd: confirmed.maxTotalChargeUsd,
      expected_items: typeof p.expected_items === 'number' ? p.expected_items : undefined,
    })
    if (!check.ok) throw new ActionFailure(`re-check failed: ${check.error}`, { actor_id: actorId })
    const options = tightenOptions(confirmed, String(p.pricing_model ?? ''), check.plan)
    if (typeof options === 'string') throw new ActionFailure(options, { actor_id: actorId })
    const run = await startRun(actorId, input, options)
    return {
      actor_id: actorId,
      run_id: run.id,
      status: run.status,
      dataset_id: run.datasetId,
      console_url: run.consoleUrl,
      options: options as unknown as Json,
    }
  },

  /**
   * Replace a campaign's email sequence with the confirmed edit. Re-reads the
   * live sequence first: if it is not the one the edit was made against
   * (`before_hash`), nothing is written and the owner re-opens the editor.
   */
  async update_sequence(p) {
    const campaignId = need(p, 'campaign_id')
    const beforeHash = need(p, 'before_hash')
    if (!Array.isArray(p.steps) || !p.steps.length) throw new ActionFailure('payload.steps is missing')
    const current = await getSequenceFresh(campaignId)
    if (current.hash !== beforeHash) {
      throw new ActionFailure('Sequence changed in Instantly since this edit was filed. Re-open the editor and make the edit again.', {
        campaign_id: campaignId,
        stale: true,
        current_hash: current.hash,
      })
    }
    await patchSequence(campaignId, p.steps as unknown as InstantlyStep[])
    const after = await getSequenceFresh(campaignId).catch(() => null)
    return { campaign_id: campaignId, steps: p.steps.length, after_hash: after?.hash ?? null }
  },

  async create_campaign(p) {
    const created = await createCampaignFrom(need(p, 'source_campaign_id'), need(p, 'name'))
    return { source_campaign_id: need(p, 'source_campaign_id'), campaign_id: created.id, name: created.name }
  },
}

/** Exposed for tests: every kind has a handler. */
export const EXECUTABLE_KINDS = Object.keys(HANDLERS) as PendingActionRow['kind'][]

function summaryOf(a: PendingActionRow): string {
  return str(a.payload?.summary) ?? a.kind
}

async function report(a: PendingActionRow, status: 'executed' | 'failed', result: Record<string, Json>, error: string | null) {
  const head = status === 'executed' ? (result.timeout ? `⏳ Sent, still running` : `✅ Done`) : `⚠️ Failed`
  const link = actionLink(a.id)
  const lines = [`${head} — ${a.kind}`, summaryOf(a)]
  if (error) lines.push(error)
  if (link) lines.push(link)
  try {
    await sendMessage(lines.join('\n'), { disablePreview: true })
  } catch (err) {
    console.error('[actions] telegram outcome failed:', err instanceof Error ? err.message : err)
  }
  try {
    await logEvent({
      type: `lume.action.${status}`,
      source: 'lume',
      source_id: a.id,
      title: `${a.kind} ${status}`,
      payload: { kind: a.kind, error, result },
    })
  } catch (err) {
    console.error('[actions] logEvent failed:', err instanceof Error ? err.message : err)
  }
}

export async function executeAction(id: string): Promise<ExecuteOutcome> {
  const action = await claimExecution(id)
  if (!action) {
    const row = await getAction(id)
    return row ? { ran: false, reason: 'not_claimable', status: row.status } : { ran: false, reason: 'not_found' }
  }

  let status: 'executed' | 'failed'
  let result: Record<string, Json>
  let error: string | null = null
  try {
    const handler = HANDLERS[action.kind]
    if (!handler) throw new ActionFailure(`unknown kind ${action.kind}`)
    result = await handler(action.payload ?? {}, action)
    status = 'executed'
  } catch (err) {
    status = 'failed'
    error = err instanceof Error ? err.message : String(err)
    result = { ...(err instanceof ActionFailure ? err.result : {}), error }
  }

  await finishAction(id, status, result, error)
  await report(action, status, result, error)
  return { ran: true, status, result, error }
}

export const SWEEP_AFTER_MS = 2 * 60_000
/** Approved actions dispatched per tick; the rest wait for the next one. */
export const SWEEP_LIMIT = 10
/** How long a dispatch waits for the execute route before calling it sent. */
export const DISPATCH_TIMEOUT_MS = 2_500
/** An `executing` row this old was cut mid-handler (execute's maxDuration is 300 s). */
export const INTERRUPTED_AFTER_MS = 10 * 60_000

export type SweepOutcome = 'dispatched' | { error: string }

/**
 * Re-dispatch approved actions nobody executed (the Telegram path fires
 * execute under waitUntil, which can be cut). The tick never runs them
 * inline (its maxDuration is 60 s, a handler can take minutes): each id is a
 * POST to `${origin}/api/actions/<id>/execute` with `X-Lume-Secret`, the same
 * call telegram-inbox makes, so the action runs in its own 300 s function.
 * Only the first ~2.5 s are awaited: an abort means the request went out and
 * the route is working, so it counts as dispatched. The route's claim makes a
 * duplicate dispatch a no-op. At most SWEEP_LIMIT per tick.
 */
export async function sweepStuckActions(now: Date, origin: string): Promise<{ id: string; outcome: SweepOutcome }[]> {
  const ids = await getStaleApprovedIds(new Date(now.getTime() - SWEEP_AFTER_MS), SWEEP_LIMIT)
  if (!ids.length) return []
  const secret = process.env.LUME_ACTION_SECRET
  if (!secret) return ids.map((id) => ({ id, outcome: { error: 'LUME_ACTION_SECRET is not set' } }))
  const base = origin.replace(/\/+$/, '')
  return Promise.all(ids.map(async (id) => ({ id, outcome: await dispatchExecute(`${base}/api/actions/${id}/execute`, secret) })))
}

async function dispatchExecute(url: string, secret: string): Promise<SweepOutcome> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lume-Secret': secret },
      body: '{}',
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    // A fast answer: a no-op (already claimed), a quick handler, or a refusal.
    return res.ok ? 'dispatched' : { error: `execute returned ${res.status}` }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') return 'dispatched'
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * `executing` rows older than INTERRUPTED_AFTER_MS → `failed` (result.error =
 * 'interrupted') + a Telegram notice. Never re-run: the handler may already
 * have reached Instantly or the pipeline. Called by the rotation tick.
 */
export async function recoverInterruptedActions(now: Date): Promise<string[]> {
  const rows = await failInterruptedActions(new Date(now.getTime() - INTERRUPTED_AFTER_MS))
  for (const a of rows) {
    const link = actionLink(a.id)
    const lines = [
      `⚠️ Interrupted — ${a.kind}`,
      summaryOf(a),
      'The run was cut off before it finished. It may have partly happened; check before redoing it.',
    ]
    if (link) lines.push(link)
    try {
      await sendMessage(lines.join('\n'), { disablePreview: true })
    } catch (err) {
      console.error('[actions] telegram interrupted notice failed:', err instanceof Error ? err.message : err)
    }
    try {
      await logEvent({
        type: 'lume.action.failed',
        source: 'lume',
        source_id: a.id,
        title: `${a.kind} interrupted`,
        payload: { kind: a.kind, error: 'interrupted' },
      })
    } catch (err) {
      console.error('[actions] logEvent failed:', err instanceof Error ? err.message : err)
    }
  }
  return rows.map((r) => r.id)
}
