/**
 * Reply desk engine. Ports in, no I/O of its own (live.ts wires Supabase,
 * Claude and Slack; tests use in-memory ports).
 *
 *  1. handleMessage: a message in the one configured SendPilot channel (never
 *     another channel, never Lume's own bot, never a thread reply). The raw
 *     message is saved first; then Haiku extracts the person and labels the
 *     reply. interested / question / not_now create or update the person's
 *     deal in Conversation, stop any follow-up schedule, and a drafted answer
 *     is posted as a thread reply under the notification.
 *  2. handleButton: Sent starts the follow-up schedule (or the single "not
 *     now" check-in); Redo posts a new draft; Booked moves the deal to Demo;
 *     Not interested closes it. Every decision is recorded.
 *  3. runTick: due follow-ups and check-ins are drafted and posted in the
 *     same thread, weekdays 8 AM to 6 PM Pacific only.
 * Lume never sends a LinkedIn message: Frank copies the draft by hand.
 * Every Claude call is checked against reply_desk_config.monthly_cap_usd first.
 */
import { monthStartIso, ptParts } from '@/lib/content/config'
import { canSpend, checkinDue, followupDue, inWindow, type CallKind, type ReplyDeskConfig, DRAFT_MAX_OUTPUT, EXTRACT_MAX_OUTPUT } from '@/lib/replydesk/config'
import { checkDraft, draftSystem, draftUser, fallbackDraft, pickMacro, type DraftInput, type DraftKind, DRAFT_SCHEMA } from '@/lib/replydesk/draft'
import { ACTIONABLE, EXTRACT_SCHEMA, EXTRACT_SYSTEM, extractUser, flatten, parseExtraction, type Extraction, type Label, type RawMessage } from '@/lib/replydesk/extract'
import type { Fact, MacroId } from '@/lib/replydesk/macros'
import { decidedMessage, draftMessage, noteMessage, type DraftView, type RdeskDecision } from '@/lib/replydesk/message'

// ── ports ──────────────────────────────────────────────────────────────────

export interface InboundRow {
  id: number
  team_id: string
  channel_id: string
  ts: string
  received_at: string
  label: Label | null
  person_name: string | null
  company: string | null
  linkedin_url: string | null
  message: string | null
  check_back_on: string | null
  deal_id: string | null
}

export interface DraftRow {
  id: number
  deal_id: string
  inbound_id: number | null
  kind: DraftKind
  step: number | null
  macro: string | null
  body: string
  status: 'posted' | 'sent' | 'redone' | 'booked' | 'not_interested' | 'superseded' | 'failed'
  team_id: string
  channel_id: string
  thread_ts: string
  slack_ts: string | null
  created_at: string
}

export interface ThreadRow {
  deal_id: string
  team_id: string
  channel_id: string
  thread_ts: string
  inbound_id: number | null
  last_label: Label | null
  schedule: 'followup' | 'checkin' | null
  anchor_at: string | null
  next_step: number
  next_due_at: string | null
  stopped_reason: string | null
  last_sent_at: string | null
}

export interface DealRef {
  id: string
  stage: string
  name: string | null
  company: string | null
}

export interface PersonMatch {
  deal: DealRef | null
  /** A LinkedIn signal person with this profile, when there is one. */
  signal: { name: string | null; company: string | null; email: string | null } | null
}

export interface Store {
  getConfig(): Promise<ReplyDeskConfig>
  monthSpend(fromIso: string): Promise<number>
  addSpend(row: { kind: CallKind; model: string; usd: number; input_tokens: number; output_tokens: number; inbound_id?: number | null; draft_id?: number | null }): Promise<void>
  /** Insert the raw message; null when (channel, ts) was already saved. */
  saveInbound(row: { team_id: string; channel_id: string; ts: string; raw: RawMessage }): Promise<number | null>
  updateInbound(id: number, patch: Partial<Omit<InboundRow, 'id'>> & { status?: string; extraction?: unknown; error?: string | null }): Promise<void>
  getInbound(id: number): Promise<InboundRow | null>
  matchPerson(linkedinUrl: string | null): Promise<PersonMatch>
  createDeal(row: { linkedin_url: string | null; email: string | null; name: string | null; company: string | null }): Promise<DealRef>
  updateDeal(id: string, patch: { linkedin_url?: string; name?: string; company?: string }): Promise<void>
  setStage(dealId: string, stage: string, source: 'user' | 'agent', reason?: string | null, payload?: Record<string, unknown>): Promise<string | null>
  addActivity(dealId: string, kind: 'sent' | 'replied' | 'note', payload: Record<string, unknown>, source: 'user' | 'agent', dedupeKey: string): Promise<void>
  getThread(dealId: string): Promise<ThreadRow | null>
  upsertThread(row: ThreadRow): Promise<void>
  /** Patch; when `ifDueAt` is given, only if next_due_at still equals it (the tick's claim). True when a row changed. */
  patchThread(dealId: string, patch: Partial<ThreadRow>, ifDueAt?: string): Promise<boolean>
  dueThreads(nowIso: string, limit: number): Promise<ThreadRow[]>
  insertDraft(row: Omit<DraftRow, 'id' | 'created_at'> & { model: string | null; usd: number; reason: string | null }): Promise<DraftRow>
  /** Patch; when `from` is given, only if the status is still `from`. True when a row changed. */
  patchDraft(id: number, patch: Partial<DraftRow> & { decided_at?: string; decided_by?: string | null }, from?: DraftRow['status']): Promise<boolean>
  getDraft(id: number): Promise<DraftRow | null>
  dealDrafts(dealId: string): Promise<DraftRow[]>
  facts(): Promise<Fact[]>
}

export interface AiCall {
  kind: CallKind
  model: string
  system: string
  user: string
  schema: Record<string, unknown>
  maxTokens: number
}
export interface AiResult {
  model: string
  text: string | null
  stop: string
  usd: number
  input_tokens: number
  output_tokens: number
}
export interface AiPort {
  call(c: AiCall): Promise<AiResult>
}

export interface SlackPort {
  /** The Lume bot's own user id in this workspace (to ignore its messages). */
  botUserId(team: string): Promise<string | null>
  postThread(team: string, channel: string, threadTs: string, msg: { text: string; blocks: unknown[] }): Promise<{ ts: string } | { error: string }>
  update(team: string, channel: string, ts: string, msg: { text: string; blocks: unknown[] }): Promise<void>
}

export interface Deps {
  store: Store
  ai: AiPort
  slack: SlackPort
  now: () => Date
}

// ── shared ─────────────────────────────────────────────────────────────────

export const LINKEDIN_CAMPAIGN_ID = 'linkedin'
/** Stages a new inbound does not pull a deal back from. */
const PAST_CONVERSATION = new Set(['Demo', 'Pilot', 'Paid', 'Won', 'Lost', 'Meeting booked', 'Bounced'])
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const firstName = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] || null

/** One Claude call, cap-checked first and recorded after. Null when the cap would be passed or the call failed. */
async function callClaude(deps: Deps, cfg: ReplyDeskConfig, c: Omit<AiCall, 'maxTokens'>, link: { inbound_id?: number | null; draft_id?: number | null }): Promise<AiResult | null> {
  const mtd = await deps.store.monthSpend(monthStartIso(deps.now()))
  if (!canSpend(mtd, cfg, c.kind, c.model)) return null
  try {
    const res = await deps.ai.call({ ...c, maxTokens: c.kind === 'extract' ? EXTRACT_MAX_OUTPUT : DRAFT_MAX_OUTPUT })
    await deps.store.addSpend({ kind: c.kind, model: res.model, usd: res.usd, input_tokens: res.input_tokens, output_tokens: res.output_tokens, ...link })
    return res
  } catch (err) {
    console.error('[replydesk] claude call failed:', msg(err))
    return null
  }
}

export interface WrittenDraft {
  macro: MacroId
  body: string
  model: string | null
  usd: number
  /** Why the macro fallback was posted instead of Claude's text, when it was. */
  fallback: string | null
}

/** Claude writes it; a draft that breaks a rule is retried once, then the macro fallback is used. */
export async function writeDraft(deps: Deps, cfg: ReplyDeskConfig, input: DraftInput, inboundId: number | null): Promise<WrittenDraft> {
  const facts = await deps.store.facts()
  const system = draftSystem(facts)
  let usd = 0
  let lastError = 'cap_reached'
  let model: string | null = null
  for (let i = 0; i < 2; i++) {
    const user = i === 0 ? draftUser(input) : `${draftUser(input)}\n\nYour last draft broke a rule (${lastError}). Write it again, following every rule.`
    const res = await callClaude(deps, cfg, { kind: 'draft', model: cfg.models.draft, system, user, schema: DRAFT_SCHEMA as unknown as Record<string, unknown> }, { inbound_id: inboundId })
    if (!res) break
    usd += res.usd
    model = res.model
    const c = checkDraft(res.stop === 'refusal' ? null : res.text, input, facts)
    if (c.ok) return { macro: c.macro, body: c.body, model, usd, fallback: null }
    lastError = c.error
  }
  const fb = fallbackDraft(input, pickMacro(input))
  return { ...fb, model, usd, fallback: lastError }
}

/** Write a draft and post it in the thread. The draft row is recorded either way (status failed when Slack refused). */
async function postDraft(deps: Deps, cfg: ReplyDeskConfig, at: { deal: DealRef; team: string; channel: string; thread_ts: string; inbound_id: number | null }, input: DraftInput): Promise<DraftRow> {
  const w = await writeDraft(deps, cfg, input, at.inbound_id)
  const row = await deps.store.insertDraft({
    deal_id: at.deal.id,
    inbound_id: at.inbound_id,
    kind: input.kind,
    step: input.kind === 'followup' ? (input.step ?? 0) : null,
    macro: w.macro,
    body: w.body,
    status: 'posted',
    team_id: at.team,
    channel_id: at.channel,
    thread_ts: at.thread_ts,
    slack_ts: null,
    model: w.model,
    usd: w.usd,
    reason: w.fallback ? `fallback:${w.fallback}` : null,
  })
  const view: DraftView = { id: row.id, kind: row.kind, step: row.step, body: row.body, name: at.deal.name }
  const posted = await deps.slack.postThread(at.team, at.channel, at.thread_ts, draftMessage(view))
  if ('ts' in posted) {
    await deps.store.patchDraft(row.id, { slack_ts: posted.ts })
    return { ...row, slack_ts: posted.ts }
  }
  await deps.store.patchDraft(row.id, { status: 'failed' })
  console.error('[replydesk] slack post failed:', posted.error)
  return { ...row, status: 'failed' }
}

// ── 1. an inbound message ──────────────────────────────────────────────────

/** A Slack `message` event as parsed by lib/slack/payloads (team/channel/ts validated). */
export interface MessageEvent {
  team: string
  channel: string
  ts: string
  thread_ts: string | null
  user: string | null
  raw: RawMessage
}

export type HandleResult =
  | { ok: true; ignored: 'not_configured' | 'other_channel' | 'own_bot' | 'thread_reply' | 'duplicate' | 'empty' }
  | { ok: true; inbound_id: number; label: Label | null; deal_id: string | null; draft_id: number | null; error?: string }

export async function handleMessage(ev: MessageEvent, deps: Deps): Promise<HandleResult> {
  const cfg = await deps.store.getConfig()
  if (!cfg.slack.channel_id) return { ok: true, ignored: 'not_configured' }
  if (ev.channel !== cfg.slack.channel_id || (cfg.slack.team_id && ev.team !== cfg.slack.team_id)) return { ok: true, ignored: 'other_channel' }
  if (ev.thread_ts && ev.thread_ts !== ev.ts) return { ok: true, ignored: 'thread_reply' }
  const bot = await deps.slack.botUserId(ev.team)
  if (bot && ev.user === bot) return { ok: true, ignored: 'own_bot' }
  const flat = flatten(ev.raw)
  if (!flat.trim()) return { ok: true, ignored: 'empty' }

  // Save the raw message before anything else.
  const id = await deps.store.saveInbound({ team_id: ev.team, channel_id: ev.channel, ts: ev.ts, raw: ev.raw })
  if (id === null) return { ok: true, ignored: 'duplicate' }

  const today = ptParts(deps.now()).date
  const res = await callClaude(deps, cfg, { kind: 'extract', model: cfg.models.extract, system: EXTRACT_SYSTEM, user: extractUser(flat, today), schema: EXTRACT_SCHEMA as unknown as Record<string, unknown> }, { inbound_id: id })
  const x: Extraction | null = res && res.stop !== 'refusal' ? parseExtraction(res.text, flat) : null
  if (!x) {
    const error = res ? 'extraction_invalid' : 'extraction_unavailable'
    await deps.store.updateInbound(id, { status: 'failed', error })
    return { ok: true, inbound_id: id, label: null, deal_id: null, draft_id: null, error }
  }
  await deps.store.updateInbound(id, {
    status: 'extracted',
    extraction: x,
    label: x.label,
    person_name: x.person_name,
    company: x.company,
    linkedin_url: x.linkedin_url,
    message: x.message,
    check_back_on: x.check_back_on,
  })

  const match = await deps.store.matchPerson(x.linkedin_url)

  if (!ACTIONABLE.has(x.label)) {
    // A new message from them still stops any follow-ups; no deal is created and nothing is drafted.
    if (match.deal) {
      await deps.store.updateInbound(id, { deal_id: match.deal.id })
      await deps.store.addActivity(match.deal.id, 'replied', { via: 'linkedin', inbound_id: id, label: x.label }, 'agent', `rdesk:in:${id}`)
      const t = await deps.store.getThread(match.deal.id)
      if (t?.schedule) await deps.store.patchThread(match.deal.id, { schedule: null, next_due_at: null, stopped_reason: 'new_inbound', last_label: x.label })
    }
    return { ok: true, inbound_id: id, label: x.label, deal_id: match.deal?.id ?? null, draft_id: null }
  }

  // Create or update the deal (Conversation), matched by LinkedIn URL where possible.
  let deal = match.deal
  const name = x.person_name ?? match.signal?.name ?? null
  const company = x.company ?? match.signal?.company ?? null
  if (!deal) {
    // A deal needs a LinkedIn profile or a real email; never a made-up address.
    const email = match.signal?.email ?? null
    if (!x.linkedin_url && !email) {
      await deps.store.updateInbound(id, { status: 'failed', error: 'no_profile_url' })
      await deps.slack.postThread(ev.team, ev.channel, ev.ts, noteMessage('Lume found no LinkedIn profile link in this notification, so it made no deal and no draft. Answer this one by hand.'))
      return { ok: true, inbound_id: id, label: x.label, deal_id: null, draft_id: null, error: 'no_profile_url' }
    }
    try {
      deal = await deps.store.createDeal({ linkedin_url: x.linkedin_url, email, name, company })
    } catch (err) {
      await deps.store.updateInbound(id, { status: 'failed', error: `deal_failed: ${msg(err)}`.slice(0, 500) })
      return { ok: true, inbound_id: id, label: x.label, deal_id: null, draft_id: null, error: 'deal_failed' }
    }
  } else {
    const patch: { linkedin_url?: string; name?: string; company?: string } = {}
    if (x.linkedin_url) patch.linkedin_url = x.linkedin_url
    if (!deal.name && name) patch.name = name
    if (!deal.company && company) patch.company = company
    if (Object.keys(patch).length) await deps.store.updateDeal(deal.id, patch)
    deal = { ...deal, name: deal.name ?? name, company: deal.company ?? company }
  }
  if (!PAST_CONVERSATION.has(deal.stage) && deal.stage !== 'Conversation') {
    await deps.store.setStage(deal.id, 'Conversation', 'agent', null, { via: 'reply_desk', inbound_id: id, label: x.label })
    deal = { ...deal, stage: 'Conversation' }
  }
  await deps.store.updateInbound(id, { deal_id: deal.id })
  await deps.store.addActivity(deal.id, 'replied', { via: 'linkedin', inbound_id: id, label: x.label, campaign: x.campaign, untrusted_message: x.message?.slice(0, 2000) ?? null }, 'agent', `rdesk:in:${id}`)

  // A new inbound stops the schedule and supersedes drafts still waiting; the fresh draft lives under this notification.
  for (const d of await deps.store.dealDrafts(deal.id)) if (d.status === 'posted') await deps.store.patchDraft(d.id, { status: 'superseded' }, 'posted')
  await deps.store.upsertThread({
    deal_id: deal.id,
    team_id: ev.team,
    channel_id: ev.channel,
    thread_ts: ev.ts,
    inbound_id: id,
    last_label: x.label,
    schedule: null,
    anchor_at: null,
    next_step: 0,
    next_due_at: null,
    stopped_reason: 'new_inbound',
    last_sent_at: (await deps.store.getThread(deal.id))?.last_sent_at ?? null,
  })

  const draft = await postDraft(deps, cfg, { deal, team: ev.team, channel: ev.channel, thread_ts: ev.ts, inbound_id: id }, {
    kind: 'reply',
    first_name: firstName(deal.name),
    company: deal.company,
    label: x.label,
    message: x.message,
  })
  return { ok: true, inbound_id: id, label: x.label, deal_id: deal.id, draft_id: draft.id }
}

// ── 2. buttons ─────────────────────────────────────────────────────────────

export interface ButtonEvent {
  decision: RdeskDecision
  draft_id: number
  user: string
  team: string
  channel: string
  message_ts: string
}

export type ButtonResult = { ok: true; decision: RdeskDecision; next_due_at?: string | null; new_draft_id?: number } | { ok: false; error: 'not_found' | 'already_decided' }

const STATUS_OF: Record<Exclude<RdeskDecision, 'redo'>, DraftRow['status']> = { sent: 'sent', booked: 'booked', not_interested: 'not_interested' }

export async function handleButton(b: ButtonEvent, deps: Deps): Promise<ButtonResult> {
  const draft = await deps.store.getDraft(b.draft_id)
  if (!draft || draft.channel_id !== b.channel || draft.team_id !== b.team) return { ok: false, error: 'not_found' }
  const now = deps.now()
  const nowIso = now.toISOString()
  const status: DraftRow['status'] = b.decision === 'redo' ? 'redone' : STATUS_OF[b.decision]
  // The claim: only a draft still waiting changes, so a double tap does nothing twice.
  if (!(await deps.store.patchDraft(draft.id, { status, decided_at: nowIso, decided_by: b.user }, 'posted'))) return { ok: false, error: 'already_decided' }
  const cfg = await deps.store.getConfig()
  const thread = await deps.store.getThread(draft.deal_id)
  const inbound = draft.inbound_id ? await deps.store.getInbound(draft.inbound_id) : thread?.inbound_id ? await deps.store.getInbound(thread.inbound_id) : null
  const view: DraftView = { id: draft.id, kind: draft.kind, step: draft.step, body: draft.body, name: inbound?.person_name ?? null }
  const target = draft.slack_ts ?? b.message_ts

  if (b.decision === 'sent') {
    await deps.store.addActivity(draft.deal_id, 'sent', { via: 'linkedin', draft_id: draft.id, kind: draft.kind, step: draft.step, body: draft.body }, 'user', `rdesk:sent:${draft.id}`)
    let next: string | null = thread?.next_due_at ?? null
    if (thread) {
      const patch: Partial<ThreadRow> = { last_sent_at: nowIso }
      if (draft.kind === 'reply') {
        if (thread.last_label === 'not_now') {
          next = checkinDue(nowIso, inbound?.check_back_on ?? null, cfg.checkin_days).toISOString()
          Object.assign(patch, { schedule: 'checkin', anchor_at: nowIso, next_step: 0, next_due_at: next, stopped_reason: null })
        } else {
          next = followupDue(nowIso, 0, cfg.followup_days)?.toISOString() ?? null
          Object.assign(patch, { schedule: next ? 'followup' : null, anchor_at: nowIso, next_step: 0, next_due_at: next, stopped_reason: next ? null : 'no_followup_days' })
        }
      } else if (draft.kind === 'checkin') {
        next = null
        Object.assign(patch, { schedule: null, next_due_at: null, stopped_reason: 'checkin_sent' })
      }
      await deps.store.patchThread(draft.deal_id, patch)
    }
    const note = next ? `next draft ${new Date(next).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PT` : null
    await safeUpdate(deps, draft, target, decidedMessage(view, 'sent', b.user, note))
    return { ok: true, decision: 'sent', next_due_at: next }
  }

  if (b.decision === 'redo') {
    await safeUpdate(deps, draft, target, decidedMessage(view, 'redo', b.user))
    const previous = (await deps.store.dealDrafts(draft.deal_id)).filter((d) => d.thread_ts === draft.thread_ts).map((d) => d.body).slice(-5)
    const deal: DealRef = { id: draft.deal_id, stage: '', name: inbound?.person_name ?? null, company: inbound?.company ?? null }
    const fresh = await postDraft(deps, cfg, { deal, team: draft.team_id, channel: draft.channel_id, thread_ts: draft.thread_ts, inbound_id: draft.inbound_id }, {
      kind: draft.kind,
      step: draft.step ?? undefined,
      first_name: firstName(inbound?.person_name ?? null),
      company: inbound?.company ?? null,
      label: inbound?.label ?? thread?.last_label ?? null,
      message: inbound?.message ?? null,
      previous,
    })
    return { ok: true, decision: 'redo', new_draft_id: fresh.id }
  }

  // Booked → Demo; Not interested → Lost. Either stops the schedule.
  const stage = b.decision === 'booked' ? 'Demo' : 'Lost'
  await deps.store.setStage(draft.deal_id, stage, 'user', b.decision === 'not_interested' ? 'Not interested (LinkedIn reply)' : null, { via: 'reply_desk', draft_id: draft.id, slack_user: b.user })
  if (thread) await deps.store.patchThread(draft.deal_id, { schedule: null, next_due_at: null, stopped_reason: b.decision })
  for (const d of await deps.store.dealDrafts(draft.deal_id)) if (d.status === 'posted' && d.id !== draft.id) await deps.store.patchDraft(d.id, { status: 'superseded' }, 'posted')
  await safeUpdate(deps, draft, target, decidedMessage(view, b.decision, b.user))
  return { ok: true, decision: b.decision }
}

async function safeUpdate(deps: Deps, d: DraftRow, ts: string, m: { text: string; blocks: unknown[] }): Promise<void> {
  try {
    await deps.slack.update(d.team_id, d.channel_id, ts, m)
  } catch (err) {
    console.error('[replydesk] slack update failed:', msg(err))
  }
}

// ── 3. the follow-up tick ──────────────────────────────────────────────────

export interface TickResult {
  ok: true
  skipped?: 'outside_window'
  posted: number
  errors: string[]
}

export async function runTick(deps: Deps, limit = 10): Promise<TickResult> {
  const now = deps.now()
  // Anything due outside weekdays 8 AM to 6 PM Pacific waits for the next window.
  if (!inWindow(now)) return { ok: true, skipped: 'outside_window', posted: 0, errors: [] }
  const cfg = await deps.store.getConfig()
  const out: TickResult = { ok: true, posted: 0, errors: [] }
  for (const t of await deps.store.dueThreads(now.toISOString(), limit)) {
    if (!t.schedule || !t.next_due_at) continue
    try {
      // Claim it (an overlapping tick finds next_due_at changed and moves on).
      if (!(await deps.store.patchThread(t.deal_id, { next_due_at: null }, t.next_due_at))) continue
      const inbound = t.inbound_id ? await deps.store.getInbound(t.inbound_id) : null
      const previous = (await deps.store.dealDrafts(t.deal_id)).filter((d) => d.thread_ts === t.thread_ts).map((d) => d.body).slice(-5)
      const deal: DealRef = { id: t.deal_id, stage: '', name: inbound?.person_name ?? null, company: inbound?.company ?? null }
      const kind: DraftKind = t.schedule === 'checkin' ? 'checkin' : 'followup'
      await postDraft(deps, cfg, { deal, team: t.team_id, channel: t.channel_id, thread_ts: t.thread_ts, inbound_id: t.inbound_id }, {
        kind,
        step: kind === 'followup' ? t.next_step : undefined,
        first_name: firstName(inbound?.person_name ?? null),
        company: inbound?.company ?? null,
        label: inbound?.label ?? t.last_label,
        message: inbound?.message ?? null,
        previous,
      })
      out.posted++
      if (kind === 'checkin') {
        await deps.store.patchThread(t.deal_id, { schedule: null, next_due_at: null, stopped_reason: 'checkin_posted' })
      } else {
        const step = t.next_step + 1
        const due = t.anchor_at ? followupDue(t.anchor_at, step, cfg.followup_days) : null
        await deps.store.patchThread(t.deal_id, due ? { next_step: step, next_due_at: due.toISOString() } : { next_step: step, schedule: null, next_due_at: null, stopped_reason: 'schedule_done' })
      }
    } catch (err) {
      out.errors.push(`${t.deal_id}: ${msg(err)}`)
      // Put the due time back so the next tick retries it.
      await deps.store.patchThread(t.deal_id, { next_due_at: t.next_due_at }).catch(() => undefined)
    }
  }
  return out
}
