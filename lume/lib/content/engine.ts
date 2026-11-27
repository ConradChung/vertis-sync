import { callEstimateUsd, fitsCap, monthStartIso, ptParts, round4, type ContentConfig } from '@/lib/content/config'
import { pickFacts, pickedFacts, REUSE_WINDOW_DAYS, type Fact, type LeadUse } from '@/lib/content/facts'
import { matchPosts, type MatchDraft, type MatchPost } from '@/lib/content/match'
import { buildContentMessage } from '@/lib/content/message'
import { buildSystem, buildUser, parseOutput, type References } from '@/lib/content/prompt'
import { checkDraft, type DraftOutput } from '@/lib/content/rules'
import { inScheduledWindow, slotForDay, variantFor, type Slot, type Variant } from '@/lib/content/slots'

/**
 * The LinkedIn draft generator. One run: pick the slot, pick facts, write a
 * draft with Claude, check it against the rules (rewrite up to twice), store
 * it, and post it to #content-gen unless dry_run is on. A draft that still
 * fails after three tries is stored as rejected with the reasons and posted
 * nowhere. Nothing here ever touches LinkedIn.
 *
 * Every Claude call is checked against the monthly cap first and recorded in
 * content_spend right after. Ports keep the engine testable without Claude,
 * Slack or Supabase.
 */

export const MAX_TRIES = 3
export type Trigger = 'cron' | 'manual' | 'redo'

export interface DraftRow {
  run_date: string
  slot: Slot
  variant: Variant | null
  status: 'accepted' | 'rejected'
  formula: string | null
  body: string | null
  first_comment: string | null
  char_count: number | null
  lead_fact_id: number | null
  fact_ids: number[]
  reject_reason: string | null
  attempts: number
  model: string
  usd: number
  dry_run: boolean
  trigger: Trigger
  redo_of: number | null
}

export interface ContentStore {
  getConfig(): Promise<ContentConfig>
  activeFacts(): Promise<Fact[]>
  leadUses(sinceIso: string): Promise<LeadUse[]>
  monthSpend(fromIso: string): Promise<number>
  addSpend(row: { model: string; usd: number; input_tokens: number; output_tokens: number }): Promise<number>
  linkSpend(spendIds: number[], draftId: number): Promise<void>
  hasCronDraft(runDate: string): Promise<boolean>
  insertDraft(row: DraftRow): Promise<number>
  setDraftSlack(id: number, team: string, channel: string, ts: string): Promise<void>
  recentPosts(sinceIso: string): Promise<MatchPost[]>
  unmatchedDrafts(sinceIso: string): Promise<MatchDraft[]>
  markPosted(draftId: number, postId: string, postedAt: string): Promise<boolean>
}

export interface AiResult {
  /** The model that answered (priced from it). */
  model: string
  text: string | null
  stop: string
  usd: number
  input_tokens: number
  output_tokens: number
}

export interface AiPort {
  write(req: { model: string; system: string; user: string }): Promise<AiResult>
}

export interface SlackPort {
  post(cfg: ContentConfig, msg: { text: string; blocks: unknown[] }): Promise<{ team: string; channel: string; ts: string } | { error: string }>
}

export interface Deps {
  store: ContentStore
  ai: AiPort
  slack: SlackPort
  refs: () => References
  model: string
}

export interface GenResult {
  draft_id: number
  status: 'accepted' | 'rejected'
  slot: Slot
  variant: Variant | null
  reason: string | null
  usd: number
  attempts: number
  slack: 'dry_run' | 'posted' | 'not_accepted' | { error: string }
}

export interface GenArgs {
  now: Date
  slot: Slot
  variant: Variant | null
  trigger: Trigger
  redoOf?: number | null
}

export async function generateDraft(args: GenArgs, deps: Deps): Promise<GenResult> {
  const { store, ai } = deps
  const { now, slot, variant, trigger } = args
  const cfg = await store.getConfig()
  const runDate = ptParts(now).date
  const base = { run_date: runDate, slot, variant, model: deps.model, dry_run: cfg.dry_run, trigger, redo_of: args.redoOf ?? null }

  const reject = async (reason: string, extra: Partial<DraftRow> = {}): Promise<GenResult> => {
    const row: DraftRow = {
      ...base,
      status: 'rejected',
      formula: null,
      body: null,
      first_comment: null,
      char_count: null,
      lead_fact_id: null,
      fact_ids: [],
      reject_reason: reason.slice(0, 2000),
      attempts: 0,
      usd: 0,
      ...extra,
    }
    const id = await store.insertDraft(row)
    return { draft_id: id, status: 'rejected', slot, variant, reason: row.reject_reason, usd: row.usd, attempts: row.attempts, slack: 'not_accepted' }
  }

  const facts = await store.activeFacts()
  const since = new Date(now.getTime() - REUSE_WINDOW_DAYS * 86_400_000).toISOString()
  const pick = pickFacts(slot, variant, facts, await store.leadUses(since), now)
  if ('error' in pick) return reject(pick.error)

  const provided = pickedFacts(pick)
  const system = buildSystem(deps.refs())
  const ctx = { provided, leadId: pick.lead.id, offerId: pick.offer.id, variant }
  let mtd = await store.monthSpend(monthStartIso(now))
  let usd = 0
  let attempts = 0
  const spendIds: number[] = []
  let last: DraftOutput | null = null
  let failures: string[] = []
  let accepted: { out: DraftOutput; chars: number } | null = null
  let stopReason: string | null = null

  while (attempts < MAX_TRIES) {
    if (!fitsCap(mtd, cfg.monthly_cap_usd, callEstimateUsd(deps.model))) {
      stopReason = `spend_cap_reached ($${mtd.toFixed(2)} of $${cfg.monthly_cap_usd} this month)`
      break
    }
    attempts++
    let res: AiResult
    try {
      res = await ai.write({ model: deps.model, system, user: buildUser(slot, variant, pick, last && failures.length ? { previous: last, failures } : undefined) })
    } catch (err) {
      stopReason = `claude_error: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`
      break
    }
    usd = round4(usd + res.usd)
    mtd = round4(mtd + res.usd)
    spendIds.push(await store.addSpend({ model: res.model, usd: res.usd, input_tokens: res.input_tokens, output_tokens: res.output_tokens }))
    const out = res.text !== null && res.stop !== 'refusal' && res.stop !== 'max_tokens' ? parseOutput(res.text) : null
    if (!out) {
      failures = [`The reply was not usable (stop: ${res.stop}); return JSON matching the schema.`]
      continue
    }
    last = out
    const check = checkDraft(out, ctx)
    if (check.ok) {
      accepted = { out, chars: check.charCount }
      break
    }
    failures = check.failures
  }

  if (!accepted) {
    const reason = [stopReason, failures.length ? `after ${attempts} tries: ${failures.join(' | ')}` : null].filter(Boolean).join('; ') || 'no_draft'
    const r = await reject(reason, {
      attempts,
      usd,
      lead_fact_id: pick.lead.id,
      formula: last?.formula ?? null,
      body: last?.body ?? null,
      first_comment: last?.first_comment ?? null,
      char_count: last ? last.body.length : null,
      fact_ids: last?.fact_ids ?? [],
    })
    if (spendIds.length) await store.linkSpend(spendIds, r.draft_id)
    return r
  }

  const out = accepted.out
  const factIds = [...new Set(out.fact_ids)]
  const id = await store.insertDraft({
    ...base,
    status: 'accepted',
    formula: out.formula,
    body: out.body,
    first_comment: out.first_comment,
    char_count: accepted.chars,
    lead_fact_id: pick.lead.id,
    fact_ids: factIds,
    reject_reason: null,
    attempts,
    usd,
  })
  if (spendIds.length) await store.linkSpend(spendIds, id)

  let slack: GenResult['slack'] = 'dry_run'
  if (!cfg.dry_run) {
    const msg = buildContentMessage({ id, slot, variant, formula: out.formula, body: out.body, first_comment: out.first_comment, char_count: accepted.chars, fact_ids: factIds, status: 'accepted' })
    const posted = await deps.slack.post(cfg, msg)
    if ('error' in posted) slack = { error: posted.error }
    else {
      await store.setDraftSlack(id, posted.team, posted.channel, posted.ts)
      slack = 'posted'
    }
  }
  return { draft_id: id, status: 'accepted', slot, variant, reason: null, usd, attempts, slack }
}

// ── post matching ──────────────────────────────────────────────────────────

const MATCH_LOOKBACK_DAYS = 45

export async function matchRecentPosts(now: Date, store: ContentStore): Promise<number> {
  const since = new Date(now.getTime() - MATCH_LOOKBACK_DAYS * 86_400_000).toISOString()
  const [posts, drafts] = await Promise.all([store.recentPosts(since), store.unmatchedDrafts(since)])
  let n = 0
  for (const m of matchPosts(posts, drafts)) if (await store.markPosted(m.draft_id, m.post_id, m.posted_at)) n++
  return n
}

// ── the tick ───────────────────────────────────────────────────────────────

export interface ManualRun {
  slot: Slot | null
  variant: Variant | null
}

export type TickResult =
  | { ok: true; matched: number; skipped: string }
  | { ok: true; matched: number; draft: GenResult }
  | { ok: false; matched: number; error: string }

export async function runContentTick(now: Date, manual: ManualRun | null, deps: Deps): Promise<TickResult> {
  let matched = 0
  try {
    matched = await matchRecentPosts(now, deps.store)
  } catch (err) {
    console.error('[content] post matching failed:', err instanceof Error ? err.message : err)
  }

  let slot: Slot | null
  if (manual) {
    slot = manual.slot ?? slotForDay(now)
    if (!slot) return { ok: false, matched, error: 'no_slot_today_pass_slot' }
  } else {
    slot = slotForDay(now)
    if (!slot) return { ok: true, matched, skipped: 'no_slot_today' }
    if (!inScheduledWindow(now)) return { ok: true, matched, skipped: 'outside_window' }
    if (await deps.store.hasCronDraft(ptParts(now).date)) return { ok: true, matched, skipped: 'already_ran_today' }
  }
  const variant = slot === 'hand_raiser' ? (manual?.variant ?? variantFor(slot, now)) : null
  const draft = await generateDraft({ now, slot, variant, trigger: manual ? 'manual' : 'cron' }, deps)
  return { ok: true, matched, draft }
}
