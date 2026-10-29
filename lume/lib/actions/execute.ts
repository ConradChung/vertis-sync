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
import { getEmail, getThreadEmails } from '@/lib/adapters/instantlyEmails'
import { recheckThread } from '@/lib/inbox/model'
import { getReply } from '@/lib/inbox/store'
import { applyLabel } from '@/lib/inbox/label'
import { LabelBody } from '@/lib/inbox/schemas'
import { isBlocked } from '@/lib/adapters/instantlyLabels'
import { closeReply } from '@/lib/inbox/replies'
import { grantStillHolds } from '@/lib/actions/grant'
import { slackOnAction } from '@/lib/slack/hooks'
import { clientApprovalBlocker, CLIENT_BLOCKER_TEXT } from '@/lib/slack/clientCheck'
import { GRANT_BLOCKER_TEXT } from '@/lib/inbox/replyMode'
import { alert, alertLink, titleFrom } from '@/lib/alerts'
import { routeItemForAction } from '@/lib/operators/route'
import { createOperatorKey, getVertical } from '@/lib/operators/store'
import { signInUrl } from '@/lib/operators/guard'
import { maskKeyText } from '@/lib/operators/mask'
import { configuredBaseUrl } from '@/lib/http/origin'
import { actionLink } from '@/lib/adapters/telegram.messages'
import { getPushJob, logEvent } from '@/lib/db/service'
import { executeRemoveLeads, RemovalFailure } from '@/lib/actions/removeLeads'
import { findDeal, getDeal, setStage } from '@/lib/crm/service'
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
  markSendAttempted,
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
  | {
      ran: true
      status: 'executed' | 'failed'
      result: Record<string, Json>
      error: string | null
      /**
       * Shown once to whoever approved, never stored (issue_operator_key's
       * raw sign-in link). Only with `revealOnce`.
       */
      reveal?: { sign_in_url: string }
    }

export interface ExecuteOptions {
  /**
   * The caller shows the result to the person (or bot) who just approved it
   * (Lume's decide route, skip mode). Kinds that mint a secret refuse to run
   * without it: from Telegram or the sweeper the link could never be shown.
   */
  revealOnce?: boolean
  /** Origin for links shown once (the request's); else LUME_URL. */
  origin?: string
}

/** One deadline for a send_reply's live re-check and its send. */
export const SEND_DEADLINE_MS = 120_000
/** Do not start a send with less than this left (the send call itself gets up to 30 s). */
export const SEND_MIN_TIME_MS = 30_000

/** Key in a handler's result that executeAction strips before anything is stored. */
const REVEAL = '__reveal_once'

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

type Handler = (p: Record<string, Json>, action: PendingActionRow, opts: ExecuteOptions) => Promise<Record<string, Json>>

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

  /**
   * Reply to one inbound email, safely (inbox manager 3b). One deadline
   * (SEND_DEADLINE_MS) covers the whole re-check and the send. Nothing is
   * sent unless every check passes:
   *  1. re-read the answered email and its whole thread FRESH from Instantly
   *     (no cache; waits for a /emails slot within the deadline);
   *  2. the answered email must be inbound, have an `eaccount`, and be the
   *     inbox this reply is from (`eaccount_mismatch`);
   *  3. recheckThread: the thread read must be complete (not truncated) and
   *     the answered email must be in it
   *     (`thread_unverifiable`); nobody may have written since
   *     (`newer_inbound`) and nothing may have been sent since
   *     (`already_replied`, which also catches a manual Unibox reply);
   *  4. the lead must still be replyable: the reply not closed by a label
   *     (`reply_labeled`), the deal not Lost (`deal_lost`), the address and
   *     domain not on the Instantly blocklist (`lead_blocked`);
   *  4b. approved by an Auto-mode grant (decided_via 'grant'): the grant is
   *     re-evaluated (still Auto, still GOOD, no closing label since), else
   *     `grant_revoked` / `grant_unverifiable`;
   *  4c. approved by a client in Slack (decided_via 'client', 3g): still
   *     Client mode, the workspace still bound, not the editor's own edit, no
   *     opt-out in the fresh text (lib/slack/clientCheck.ts), else the code;
   *  5. `send_attempted` is recorded, then /emails/reply on that email (so the
   *     reply stays in its thread) with the time left as its timeout. From
   *     here the row blocks another reply to this email even if it fails
   *     (pending_actions_one_reply_per_inbound_idx);
   *  6. the reply is marked handled and its alert acked (never fails the send).
   */
  async send_reply(p, action) {
    const deadline = Date.now() + SEND_DEADLINE_MS
    const replyTo = need(p, 'reply_to_uuid')
    const eaccount = need(p, 'eaccount').toLowerCase()
    const body = need(p, 'body')
    const refuse = (code: string, text: string, extra: Record<string, Json> = {}): never => {
      throw new ActionFailure(`${code}: ${text}; nothing was sent`, { reply_to_uuid: replyTo, [code]: true, ...extra })
    }
    let answered
    let thread
    let truncated = false
    let replyRow
    let deal
    let blocked
    try {
      answered = await getEmail(replyTo, { fresh: true, deadline })
      const read = answered ? await getThreadEmails(answered.thread_id, { fresh: true, deadline }) : { emails: [], truncated: false }
      thread = read.emails
      truncated = read.truncated
      if (answered?.lead) {
        const campaign = answered.campaign_id ?? str(p.campaign_id)
        ;[replyRow, deal, blocked] = await Promise.all([
          getReply(replyTo),
          campaign ? findDeal(campaign, answered.lead) : Promise.resolve(null),
          isBlocked(answered.lead),
        ])
      }
    } catch (err) {
      throw new ActionFailure(`could not re-check the live thread, nothing was sent: ${err instanceof Error ? err.message : String(err)}`, { reply_to_uuid: replyTo })
    }
    if (!answered) return refuse('email_not_found', 'the email being answered is not in Instantly any more')
    if (answered.direction !== 'in') return refuse('not_an_inbound_email', 'that email is one of ours')
    if (!answered.eaccount) return refuse('no_eaccount', 'Instantly does not say which inbox received that email')
    if (answered.eaccount !== eaccount) {
      return refuse('eaccount_mismatch', `the reply was received by ${answered.eaccount}, not ${eaccount}`, { received_by: answered.eaccount })
    }
    if (truncated) return refuse('thread_unverifiable', 'the thread is longer than Lume reads in one check, so it cannot be proven nothing came after')
    const check = recheckThread(thread, replyTo)
    if (!check.ok) {
      if (check.code === 'thread_unverifiable') return refuse('thread_unverifiable', 'the answered email is not in the re-read thread, so it cannot be checked')
      if (check.code === 'newer_inbound') {
        return refuse('newer_inbound', 'a newer message arrived in this thread after the one this reply answers. Read the thread and draft again', {
          newer_reply_to_uuid: check.email.id,
          newer_at: check.email.created_at ?? check.email.at,
          thread_id: answered.thread_id,
        })
      }
      return refuse('already_replied', 'an email was already sent in this thread after the one this reply answers', {
        outbound_email_id: check.email.id,
        thread_id: answered.thread_id,
      })
    }
    if (!answered.lead) return refuse('lead_unknown', 'Instantly does not say who the lead is')
    if (replyRow?.handled_how?.startsWith('label:')) return refuse('reply_labeled', `the reply was labeled ${replyRow.handled_how.slice(6)}`)
    if (deal?.stage === 'Lost') return refuse('deal_lost', 'the CRM deal is Lost')
    if (blocked) return refuse('lead_blocked', 'the address or its domain is on the Instantly blocklist')
    // Auto mode (decided_via 'grant'): nobody approved it, so the grant itself
    // is re-checked last: still Auto, and nothing since holds it for a person.
    if (action.decided_via === 'grant') {
      // The grant belongs to one campaign: the answered email must be in it.
      if (!answered.campaign_id || answered.campaign_id !== str(p.campaign_id)) {
        return refuse('campaign_mismatch', "the Auto-mode grant is for another campaign than the answered email's", { answered_campaign_id: answered.campaign_id ?? null })
      }
      let held
      try {
        held = await grantStillHolds(action, answered)
      } catch (err) {
        return refuse('grant_unverifiable', `the Auto-mode grant could not be re-checked (${err instanceof Error ? err.message : String(err)})`)
      }
      if (held) return refuse('grant_revoked', `the Auto-mode grant no longer holds: ${GRANT_BLOCKER_TEXT[held]}`, { grant_blocker: held })
    }
    // 4c. A client's approval in Slack (decided_via 'client', 3g) is re-checked
    // the same way: still Client mode, still bound, not self-edited, no opt-out.
    if (action.decided_via === 'client') {
      let blocked
      try {
        blocked = await clientApprovalBlocker(action, answered)
      } catch (err) {
        return refuse('client_unverifiable', `the client's approval could not be re-checked (${err instanceof Error ? err.message : String(err)})`)
      }
      if (blocked) return refuse(blocked, `the client's approval no longer holds: ${CLIENT_BLOCKER_TEXT[blocked]}`, { client_blocker: blocked })
    }
    if (deadline - Date.now() < SEND_MIN_TIME_MS) return refuse('deadline_exceeded', 'the re-check took too long to send safely now')

    try {
      await markSendAttempted(action.id)
    } catch (err) {
      throw new ActionFailure(`could not record the send attempt, nothing was sent: ${err instanceof Error ? err.message : String(err)}`, { reply_to_uuid: replyTo })
    }
    const subject = str(p.subject) ?? (answered.subject ? (/^re:/i.test(answered.subject) ? answered.subject : `Re: ${answered.subject}`) : 'Re:')
    const sent = await sendReply({ eaccount, reply_to_uuid: replyTo, subject, body, timeoutMs: deadline - Date.now() })
    try {
      await closeReply(replyTo, 'replied', { actionId: action.id })
    } catch (err) {
      console.error('[actions] closing the reply failed:', err instanceof Error ? err.message : err)
    }
    return { reply_to_uuid: replyTo, email_id: sent.id ?? null, thread_id: answered.thread_id, eaccount }
  },

  /** An approved blocking label (the agent asked; the owner or a bot approved). */
  async label_reply(p) {
    const pick: Record<string, Json> = {}
    for (const k of ['reply_to_uuid', 'category', 'verdict', 'block', 'note'] as const) if (p[k] !== undefined && p[k] !== null) pick[k] = p[k]
    if (!pick.reply_to_uuid) {
      if (p.lead_email !== undefined) pick.lead_email = p.lead_email
      if (p.campaign_id !== undefined) pick.campaign_id = p.campaign_id
    }
    const parsed = LabelBody.safeParse(pick)
    if (!parsed.success) throw new ActionFailure('payload is not a valid label')
    const out = await applyLabel(parsed.data, { all: true, operator: null }, 'agent (approved)')
    return out as unknown as Record<string, Json>
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

  /**
   * Mint a Grok Bot key for a live vertical. The raw sign-in link goes back
   * once, out of band (`reveal`); the stored result keeps it masked.
   */
  async issue_operator_key(p, _action, opts) {
    if (!opts.revealOnce) {
      throw new ActionFailure('An operator key can only be issued from Lume (the sign-in link is shown once to whoever approves). Approve it on its /actions page.')
    }
    const verticalId = need(p, 'vertical_id')
    const v = await getVertical(verticalId)
    if (!v || v.archived_at) throw new ActionFailure('vertical not found or archived', { vertical_id: verticalId })
    const label = str(p.label) ?? `${v.name} bot`
    const { operator, rawKey } = await createOperatorKey({ verticalId: v.id, label })
    const origin = opts.origin || configuredBaseUrl()
    const url = signInUrl(origin, rawKey)
    return {
      operator_id: operator.id,
      vertical_id: v.id,
      vertical_name: v.name,
      label: operator.label,
      sign_in_url_masked: maskKeyText(url),
      [REVEAL]: { sign_in_url: url },
    }
  },

  /**
   * Delete confirmed leads from an Instantly campaign (lib/actions/removeLeads.ts):
   * re-reads them, always skips replied / interested ones, snapshots each into
   * lume_cycled_leads, deletes by id; a cycle-out rule's refill is filed as an
   * assign_leads action. A failed delete is `uncertain` (it may have partly run).
   */
  async remove_leads(p, action) {
    try {
      return await executeRemoveLeads(p, action)
    } catch (err) {
      if (err instanceof RemovalFailure) throw new ActionFailure(err.message, err.result)
      throw err
    }
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
  if (result.stopped === 'time_budget' && typeof result.remaining === 'number' && result.remaining > 0) {
    const n = result.remaining
    lines.push(`Stopped on the time budget: ${n} lead${n === 1 ? ' remains' : 's remain'}; ask the agent to remove them again.`)
  }
  if (link) lines.push(link)
  const text = lines.join('\n')
  const route = routeItemForAction(a)
  try {
    await alert({
      source: 'lume.actions', severity: status === 'executed' ? 'info' : 'warn', title: titleFrom(text), body: text,
      link: alertLink(`/actions/${a.id}`), campaign_id: route.campaign_id, scope: route.scope, owner_only: route.owner_only,
      telegram: () => sendMessage(text, { disablePreview: true }),
    })
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

export async function executeAction(id: string, opts: ExecuteOptions = {}): Promise<ExecuteOutcome> {
  const action = await claimExecution(id)
  if (!action) {
    const row = await getAction(id)
    return row ? { ran: false, reason: 'not_claimable', status: row.status } : { ran: false, reason: 'not_found' }
  }

  let status: 'executed' | 'failed'
  let result: Record<string, Json>
  let error: string | null = null
  let reveal: { sign_in_url: string } | undefined
  try {
    const handler = HANDLERS[action.kind]
    if (!handler) throw new ActionFailure(`unknown kind ${action.kind}`)
    const { [REVEAL]: once, ...rest } = await handler(action.payload ?? {}, action, opts)
    result = rest
    if (once && typeof once === 'object' && !Array.isArray(once) && typeof once.sign_in_url === 'string') reveal = { sign_in_url: once.sign_in_url }
    status = 'executed'
  } catch (err) {
    status = 'failed'
    error = err instanceof Error ? err.message : String(err)
    result = { ...(err instanceof ActionFailure ? err.result : {}), error }
  }

  await finishAction(id, status, result, error)
  await report(action, status, result, error)
  // 3g: show the outcome on the reply's client-channel posts.
  slackOnAction(action)
  return { ran: true, status, result, error, ...(reveal ? { reveal } : {}) }
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

/**
 * Start one approved action in its own function (the sweeper's dispatch) and
 * return after ~2.5 s, for callers that must answer fast (a plain form post
 * from /operator). Without LUME_ACTION_SECRET it reports an error and the
 * caller runs the executor inline instead.
 */
export async function dispatchExecuteNow(id: string, origin: string): Promise<SweepOutcome> {
  const secret = process.env.LUME_ACTION_SECRET
  if (!secret) return { error: 'LUME_ACTION_SECRET is not set' }
  return dispatchExecute(`${origin.replace(/\/+$/, '')}/api/actions/${id}/execute`, secret)
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
    const text = lines.join('\n')
    const route = routeItemForAction(a)
    try {
      await alert({
        source: 'lume.actions', severity: 'warn', title: titleFrom(text), body: text,
        link: alertLink(`/actions/${a.id}`), campaign_id: route.campaign_id, scope: route.scope, owner_only: route.owner_only,
        telegram: () => sendMessage(text, { disablePreview: true }),
      })
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
