// Supabase Edge Function: influencer-reactions — the PM influencer reactions
// pipeline (Lume built-in skill "PM influencer reactions → Apollo CSV"), a
// resumable port of ~/Downloads/pm-reactions-pipeline.
//
// POST { action: 'start', influencer_ids, max_verify_usd?, start_action_id?, estimate? }
//        creates the run (one active run at a time; idempotent per
//        start_action_id) and runs stages posts + top_posts, then STOPS at
//        awaiting_approval with the exact reactions bill.
// POST { action: 'approve_reactions', run_id, approved_usd, reactions_action_id?, max_verify_usd? }
//        only after the owner approved that bill in Lume: continues with
//        reactions, triage, verify, doors, output.
// POST { action: 'cancel', run_id }   cancels and aborts the run's live Apify runs.
// POST { run_id, prev }               internal: the hand-off chain.
//
// Caller: service role only (constant-time compare with SUPABASE_SERVICE_ROLE_KEY);
// this function spends money. Lume calls it from the executor of an approved
// pending action (influencer_run / influencer_reactions), never on its own.
//
// Stages (influencer_runs.stage):
//   posts      harvestapi~linkedin-profile-posts per influencer (lookback_days)
//   top_posts  Haiku PM-relevance (20 per call), top 10 by likes, exact
//              reactions bill (sum of min(likes, cap) x $1.5/1k) -> awaiting_approval
//   reactions  harvestapi~linkedin-post-reactions per influencer (top-10 URLs,
//              maxItems = the influencer's cap); merged into influencer_reactors
//              (deduped by LinkedIn URL, reacted_to / reacted_posts unions)
//   triage     Haiku headline triage (50 per call) of reactors never triaged
//   verify     Perplexity Sonar + Haiku JSON parse for candidates never verified
//              (2 workers, 5/10/20/40 s backoff on 429/5xx), door count kept only
//              from a cited source; capped at max_verify_usd per run
//   doors      targeted door-count retry for verified rows without one (same cap)
//   output     counts, actual cost per vendor, influencers.last_* stats
//
// Every Apify start goes through lume_influencer_reserve_apify (the research
// layer's monthly cap, LUME_RESEARCH_APIFY_CAP_USD, shared with
// company-research) and carries maxTotalChargeUsd = the reservation. The Apify
// run id is stored before polling; a (run, influencer, kind) row is never
// started twice, so a dataset is never paid for twice.
//
// Resumable: one invocation works in steps for at most ~60 s of starts (wall
// clock 150 s), then hands off to a fresh invocation with a lease token
// (lume_influencer_claim_run). Runs whose chain died are failed by the stale
// sweep (lume_influencer_sweep_stale) on every invocation and their Apify runs
// aborted.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }
import { alert, gateKey, lumeLink } from '../_shared/alert.ts'
import { secretsMatch } from '../_shared/lume/action.ts'
import { parseCap, parseMonthlyUsage } from '../_shared/research/crawl.ts'
import {
  apifyActualUsd,
  estimateReactions,
  haikuUsd,
  POSTS_ACTOR,
  postsReserveUsd,
  PRICE_PER_1K_POSTS,
  PRICE_PER_1K_REACTIONS,
  REACTIONS_ACTOR,
  reactionsMaxChargeUsd,
  TOP_POSTS,
} from '../_shared/influencer/cost.ts'
import { parseJsonResponse, type JsonRequest } from '../_shared/influencer/haiku.ts'
import { applyRelevance, buildPostsInput, flattenPosts, parseRelevance, RELEVANCE_BATCH, relevanceRequest, topN } from '../_shared/influencer/posts.ts'
import { aggregateReactors, buildReactionsInput, flattenReactions } from '../_shared/influencer/reactions.ts'
import { parseTriage, TRIAGE_BATCH, triageRequest, triageTodo, type TriageLabel } from '../_shared/influencer/triage.ts'
import {
  doorQuestion,
  groundDoorCount,
  MAX_VERIFY_ATTEMPTS,
  parsePerplexity,
  parseVerifyJson,
  perplexityRequest,
  PPLX_URL,
  type PplxAnswer,
  RETRY_BACKOFF_MS,
  retryable,
  verdict,
  verificationQuestion,
  verifyParseRequest,
  VERIFY_WORKERS,
} from '../_shared/influencer/verify.ts'
import { influencerStats, runCounts, type StatReactor } from '../_shared/influencer/stats.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_API_TOKEN = Deno.env.get('APIFY_API_TOKEN') ?? ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const PERPLEXITY_API_KEY = Deno.env.get('PERPLEXITY_API_KEY') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const APIFY = 'https://api.apify.com/v2'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const FN = 'influencer-reactions'

/** Edge wall clock (s) and the time budget per invocation, from the request start. */
export const WALL_CLOCK_MS = 150_000
/** A step (one Haiku batch, two verifies, an Apify start/poll round) takes at most ~80 s; none starts after this. */
export const STEP_CUTOFF_MS = 60_000
export const POLL_SLEEP_MS = 10_000
export const STALE_MINUTES = 30
/** Transient errors in a row before a run is failed (each invocation retries the step once with backoff). */
export const MAX_TRANSIENT_STREAK = 8
const TRANSIENT_PAUSE_MS = 15_000
const HANDOFF_MS = 10_000
const PPLX_TIMEOUT_MS = 40_000
const HAIKU_TIMEOUT_MS = 30_000
/** Perplexity budget per verify (one call ~ $0.006; reserve a bit more per in-flight worker). */
const PPLX_RESERVE_PER_CALL = 0.01
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'])
const MAX_VERIFY_USD_DEFAULT = 10
const MAX_VERIFY_USD_LIMIT = 50

// ---------------------------------------------------------------------------
// I/O helpers

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

async function rest(method: string, path: string, body?: unknown, prefer?: string): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: prefer ? { ...REST_HEADERS, 'Prefer': prefer } : REST_HEADERS,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new RestError(res.status, `Supabase ${method} ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : null
}

class RestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** A vendor or network failure worth retrying later (429 / 5xx / 529, timeouts, resets): the run stays running. */
export class TransientError extends Error {}

const RETRY_MS = [2_000, 5_000, 10_000]
const retryableStatus = (s: number) => s === 429 || s >= 500
/** Leave this much of the wall clock for the rest of the step and the hand-off before another attempt. */
const RETRY_RESERVE_MS = 20_000

/**
 * fetch with bounded retries on 429 / 5xx (incl. 529) and network errors, only
 * while the invocation's wall clock allows; a non-retryable status is returned
 * as-is. Exhausted retries throw TransientError.
 */
async function fetchRetry(ctx: Ctx, url: string, init: RequestInit, timeoutMs: number, attempts = 3): Promise<Response> {
  let last = ''
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (!retryableStatus(res.status)) return res
      last = `HTTP ${res.status}`
      await res.body?.cancel()
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    const wait = RETRY_MS[i]
    const left = WALL_CLOCK_MS - (ctx.deps.now() - ctx.startedAt)
    if (i === attempts - 1 || left < wait + timeoutMs + RETRY_RESERVE_MS) break
    await ctx.deps.sleep(wait)
  }
  throw new TransientError(`${new URL(url).host}: ${last}`)
}

const rpc = (fn: string, args: Record<string, unknown>) => rest('POST', `rpc/${fn}`, args, 'return=representation')

function apify(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  return fetch(`${APIFY}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${APIFY_API_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r4 = (v: number) => Math.round(v * 10_000) / 10_000
const r6 = (v: number) => Math.round(v * 1_000_000) / 1_000_000
const inList = (ids: (string | number)[]) => `(${ids.map((i) => String(i)).join(',')})`

async function sendTelegram(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    })
    await res.body?.cancel()
  } catch {
    // a missed ping is not a failure; the feed row is the record
  }
}

function notify(runId: string, kind: string, severity: 'info' | 'warn' | 'urgent', text: string): Promise<unknown> {
  const link = lumeLink('/agent')
  return alert({
    source: FN, severity, title: text.split('\n')[0].slice(0, 120), body: text.slice(0, 2000), link, scope: 'orders',
    dedupe_key: gateKey(runId, kind),
    telegram: () => sendTelegram(`${text}${link.startsWith('http') ? `\n${link}` : ''}`),
  }).catch(() => undefined)
}

async function apifyMonthlyUsage(): Promise<number | null> {
  try {
    const res = await apify('/users/me/usage/monthly')
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    return parseMonthlyUsage(await res.json())
  } catch {
    return null
  }
}

async function haiku(ctx: Ctx, req: JsonRequest): Promise<{ json: unknown; usd: number }> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  const res = await fetchRetry(ctx, ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  }, HAIKU_TIMEOUT_MS)
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const out = parseJsonResponse(await res.json())
  return { json: out.json, usd: haikuUsd(out.usage) }
}

// ---------------------------------------------------------------------------
// run state

interface Run {
  id: string
  status: string
  stage: string
  influencer_ids: string[]
  max_verify_usd: number | string
  reactions_estimate: Array<{ influencer_id: string; slug: string; name: string; posts: number; reactions: number; usd: number }> | null
  reactions_estimate_usd: number | string | null
  counts: Record<string, unknown>
  cost: Record<string, number>
  lease_token: string | null
}

interface Influencer {
  id: string
  name: string
  slug: string
  linkedin_url: string
  lookback_days: number
  max_reactions_per_post: number
  last_posts: number | null
}

interface ApifyRow {
  id: string
  influencer_id: string
  kind: 'posts' | 'reactions'
  status: string
  apify_run_id: string | null
  dataset_id: string | null
  estimate_usd: number | string
  cost_usd: number | string
  item_count: number | null
  ingested_at: string | null
}

export interface Deps {
  startedAt?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Overrides the self-invoke (tests). */
  handOff?: (runId: string, token: string) => Promise<boolean>
}

type StepResult = 'continue' | 'wait' | 'stop'

interface Ctx {
  run: Run
  deps: Required<Pick<Deps, 'now' | 'sleep'>> & Deps
  startedAt: number
  token: string
}

const RUN_COLS = 'id,status,stage,influencer_ids,max_verify_usd,reactions_estimate,reactions_estimate_usd,counts,cost,lease_token'

async function getRun(id: string): Promise<Run | null> {
  const rows = (await rest('GET', `influencer_runs?id=eq.${id}&select=${RUN_COLS}`)) as Run[]
  return rows?.[0] ?? null
}

async function getInfluencers(ids: string[]): Promise<Influencer[]> {
  return (await rest('GET',
    `influencers?id=in.${inList(ids)}&select=id,name,slug,linkedin_url,lookback_days,max_reactions_per_post,last_posts&order=name`)) as Influencer[]
}

async function getApifyRows(runId: string, kind: string): Promise<ApifyRow[]> {
  return (await rest('GET', `influencer_apify_runs?run_id=eq.${runId}&kind=eq.${kind}&select=*`)) as ApifyRow[]
}

/** Patch the run only while this invocation still holds the lease and the run is running. */
async function patchRun(ctx: Ctx, patch: Record<string, unknown>): Promise<boolean> {
  const rows = (await rest('PATCH', `influencer_runs?id=eq.${ctx.run.id}&status=eq.running&lease_token=eq.${ctx.token}`,
    { ...patch, updated_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() }, 'return=representation')) as unknown[]
  return Array.isArray(rows) && rows.length > 0
}

function addCost(ctx: Ctx, key: string, usd: number) {
  ctx.run.cost = { ...ctx.run.cost, [key]: r6(num(ctx.run.cost?.[key]) + usd) }
}

function addCount(ctx: Ctx, key: string, by: number) {
  ctx.run.counts = { ...ctx.run.counts, [key]: num(ctx.run.counts?.[key]) + by }
}

// ---------------------------------------------------------------------------
// Apify: reserve + start, poll, read

/**
 * Reserve on the shared monthly cap, then start the actor. 'stopped' when the
 * run is no longer running (cancelled or failed meanwhile): the caller stops
 * starting anything.
 *
 * Outcomes of the start call:
 *  - Apify refused (HTTP error): definitive, the row fails at $0;
 *  - no answer (timeout, network) or an answer without a run id: a run may be
 *    live, the row fails keeping its reservation as the cost;
 *  - a run id: recorded with retries; if it still cannot be recorded the run
 *    is aborted on Apify and the row fails with the run id in its error, the
 *    reservation kept as the cost.
 */
async function startApify(ctx: Ctx, inf: Influencer, kind: 'posts' | 'reactions', estimate: number, input: Record<string, unknown>): Promise<'ok' | 'stopped'> {
  const actor = kind === 'posts' ? POSTS_ACTOR : REACTIONS_ACTOR
  const gate = (await rpc('lume_influencer_reserve_apify', {
    p_run: ctx.run.id, p_influencer: inf.id, p_kind: kind, p_actor: actor, p_estimate: estimate,
    p_external_usd: await apifyMonthlyUsage(), p_cap: parseCap(Deno.env.get('LUME_RESEARCH_APIFY_CAP_USD')),
  })) as Record<string, unknown>
  if (gate?.error === 'run_not_running') {
    console.log(`[${FN}] ${ctx.run.id}: run is ${String(gate.status)}; no more starts`)
    return 'stopped'
  }
  if (!gate || gate.ok !== true) {
    const error = typeof gate?.error === 'string' ? gate.error : 'reserve_failed'
    // Recorded as a failed $0 row so the stage moves on without this influencer.
    await rest('POST', 'influencer_apify_runs?on_conflict=run_id,influencer_id,kind', {
      run_id: ctx.run.id, influencer_id: inf.id, kind, actor_id: actor, status: 'failed', estimate_usd: estimate, cost_usd: 0,
      error: `${error}${gate?.committed_usd !== undefined ? ` (committed $${gate.committed_usd} + $${estimate} > cap $${gate.cap_usd})` : ''}`.slice(0, 2000),
      finished_at: new Date().toISOString(),
    }, 'resolution=ignore-duplicates,return=minimal')
    addCount(ctx, `${kind}_budget_skipped`, 1)
    if (error === 'budget_exceeded') {
      ctx.run.counts = { ...ctx.run.counts, [`${kind}_budget_skipped_names`]: [...((ctx.run.counts?.[`${kind}_budget_skipped_names`] as string[] | undefined) ?? []), inf.name] }
    }
    console.log(`[${FN}] ${ctx.run.id} ${inf.slug} ${kind}: refused (${error})`)
    return 'ok'
  }
  if (gate.existing === true) return 'ok'
  const rowId = String(gate.id)
  const fail = (patch: Record<string, unknown>) =>
    restRetry(ctx, 'PATCH', `influencer_apify_runs?id=eq.${rowId}&status=eq.pending`, { status: 'failed', finished_at: new Date().toISOString(), ...patch })

  // Both bounds: maxTotalChargeUsd (pay-per-event) and maxItems (pay-per-result) = the reservation.
  const maxItems = Math.max(1, Math.floor(estimate * 1000 / (kind === 'posts' ? PRICE_PER_1K_POSTS : PRICE_PER_1K_REACTIONS)))
  let res: Response
  try {
    res = await apify(`/acts/${actor}/runs?maxTotalChargeUsd=${estimate}&maxItems=${maxItems}`, { method: 'POST', body: JSON.stringify(input) })
  } catch (err) {
    await fail({ error: `Apify start outcome unknown (${err instanceof Error ? err.message : String(err)}); the reservation stays as the cost`.slice(0, 2000) })
    return 'ok'
  }
  const body = await res.json().catch(() => null) as { data?: { id?: string; defaultDatasetId?: string }; error?: { message?: string } } | null
  if (!res.ok) {
    await fail({ cost_usd: 0, error: `Apify start refused (${res.status}): ${body?.error?.message ?? ''}`.slice(0, 2000) })
    return 'ok'
  }
  const runId = body?.data?.id
  if (!runId) {
    await fail({ error: `Apify answered ${res.status} without a run id; the reservation stays as the cost` })
    return 'ok'
  }
  try {
    await restRetry(ctx, 'PATCH', `influencer_apify_runs?id=eq.${rowId}`, {
      status: 'running', apify_run_id: runId, dataset_id: body?.data?.defaultDatasetId ?? null, started_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error(`[${FN}] ${ctx.run.id}: could not record Apify run ${runId}; aborting it:`, err)
    await abortApify([runId])
    // Best effort: the run id goes in the error. If this write fails too, the sweep
    // fails the pending row after 5 minutes (reservation kept as the cost).
    await fail({ error: `Apify run ${runId} started but could not be recorded; aborted. The reservation stays as the cost.` }).catch(() => undefined)
  }
  return 'ok'
}

/** A state write that must land: 3 attempts with a short backoff. */
async function restRetry(ctx: Ctx, method: string, path: string, body: unknown, attempts = 3): Promise<unknown> {
  for (let i = 1; ; i++) {
    try {
      return await rest(method, path, body)
    } catch (err) {
      if (i >= attempts) throw err
      await ctx.deps.sleep(500 * i)
    }
  }
}

interface RunData { status?: string; statusMessage?: string; defaultDatasetId?: string; usageTotalUsd?: number }

const apifyHeaders = () => ({ 'Authorization': `Bearer ${APIFY_API_TOKEN}`, 'Content-Type': 'application/json' })

async function readRun(ctx: Ctx, apifyRunId: string): Promise<RunData> {
  const res = await fetchRetry(ctx, `${APIFY}/actor-runs/${encodeURIComponent(apifyRunId)}`, { headers: apifyHeaders() }, 20_000)
  if (!res.ok) throw new Error(`Apify run read failed (${res.status})`)
  return ((await res.json()) as { data?: RunData }).data ?? {}
}

async function readItems(ctx: Ctx, datasetId: string, fields?: string): Promise<unknown[]> {
  const out: unknown[] = []
  for (let offset = 0; offset < 50_000; offset += 5_000) {
    const res = await fetchRetry(ctx,
      `${APIFY}/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=5000&offset=${offset}${fields ? `&fields=${fields}` : ''}`,
      { headers: apifyHeaders() }, 40_000)
    if (!res.ok) throw new Error(`Apify dataset read failed (${res.status})`)
    const page = await res.json() as unknown[]
    if (!Array.isArray(page)) break
    out.push(...page)
    if (page.length < 5_000) break
  }
  return out
}

/** Poll every running row once; finish the terminal ones with `ingest`. Returns whether any is still running. */
async function pollApify(ctx: Ctx, rows: ApifyRow[], ingest: (row: ApifyRow, items: unknown[]) => Promise<void>, pricePer1k: number): Promise<boolean> {
  let live = false
  for (const row of rows) {
    if (row.status !== 'running' || !row.apify_run_id) continue
    const run = await readRun(ctx, row.apify_run_id)
    if (!TERMINAL.has(run.status ?? '')) {
      live = true
      continue
    }
    const now = new Date().toISOString()
    if (run.status === 'SUCCEEDED' || run.status === 'TIMED-OUT') {
      const items = await readItems(ctx, run.defaultDatasetId ?? row.dataset_id ?? '')
      await ingest(row, items)
      await rest('PATCH', `influencer_apify_runs?id=eq.${row.id}&status=eq.running`, {
        status: 'succeeded', cost_usd: apifyActualUsd(run, items.length, pricePer1k), item_count: items.length,
        ingested_at: now, finished_at: now, ...(run.status === 'TIMED-OUT' ? { error: 'timed out: partial results' } : {}),
      })
    } else {
      const usage = typeof run.usageTotalUsd === 'number' && run.usageTotalUsd >= 0 ? run.usageTotalUsd : num(row.estimate_usd)
      await rest('PATCH', `influencer_apify_runs?id=eq.${row.id}&status=eq.running`, {
        status: 'failed', cost_usd: r4(usage), error: `Apify run ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ''}`.slice(0, 2000),
        finished_at: now,
      })
    }
  }
  return live
}

const sumCost = (rows: ApifyRow[]) => r4(rows.reduce((s, r) => s + num(r.cost_usd), 0))

// ---------------------------------------------------------------------------
// stages

async function stagePosts(ctx: Ctx): Promise<StepResult> {
  const infl = await getInfluencers(ctx.run.influencer_ids)
  let rows = await getApifyRows(ctx.run.id, 'posts')
  for (const inf of infl) {
    if (rows.some((r) => r.influencer_id === inf.id)) continue
    if (ctx.deps.now() - ctx.startedAt > STEP_CUTOFF_MS) return 'continue'
    if ((await startApify(ctx, inf, 'posts', postsReserveUsd(inf.last_posts), buildPostsInput(inf.linkedin_url, inf.lookback_days))) === 'stopped') return 'stop'
  }
  rows = await getApifyRows(ctx.run.id, 'posts')
  const live = await pollApify(ctx, rows, async (row, items) => {
    const posts = flattenPosts(items).map((p) => ({ run_id: ctx.run.id, influencer_id: row.influencer_id, ...p }))
    if (posts.length) {
      await rest('POST', 'influencer_posts?on_conflict=run_id,influencer_id,post_id', posts, 'resolution=ignore-duplicates,return=minimal')
    }
  }, PRICE_PER_1K_POSTS)
  if (live || rows.some((r) => r.status === 'pending')) return 'wait'
  rows = await getApifyRows(ctx.run.id, 'posts')
  if (rows.some((r) => r.status === 'running' || r.status === 'pending')) return 'wait'
  ctx.run.cost = { ...ctx.run.cost, apify_posts: sumCost(rows) }
  ctx.run.counts = { ...ctx.run.counts, posts: rows.reduce((s, r) => s + num(r.item_count), 0), posts_failed: rows.filter((r) => r.status === 'failed').length }
  await patchRun(ctx, { stage: 'top_posts', cost: ctx.run.cost, counts: ctx.run.counts })
  ctx.run.stage = 'top_posts'
  return 'continue'
}

interface PostDb { run_id: string; influencer_id: string; post_id: string; post_url: string; posted_at: string | null; likes: number; comments: number; shares: number; text: string | null; pm_relevant: boolean | null; relevance_reason: string | null; rank: number | null }

async function stageTopPosts(ctx: Ctx): Promise<StepResult> {
  const todo = (await rest('GET', `influencer_posts?run_id=eq.${ctx.run.id}&pm_relevant=is.null&select=*&limit=${RELEVANCE_BATCH}`)) as PostDb[]
  if (todo.length) {
    const { json, usd } = await haiku(ctx, relevanceRequest(todo))
    addCost(ctx, 'anthropic', usd)
    const labeled = applyRelevance(todo, parseRelevance(json))
    await rest('POST', 'influencer_posts?on_conflict=run_id,influencer_id,post_id', labeled, 'resolution=merge-duplicates,return=minimal')
    await patchRun(ctx, { cost: ctx.run.cost })
    return 'continue'
  }
  const infl = await getInfluencers(ctx.run.influencer_ids)
  const estimate: NonNullable<Run['reactions_estimate']> = []
  for (const inf of infl) {
    const relevant = (await rest('GET',
      `influencer_posts?run_id=eq.${ctx.run.id}&influencer_id=eq.${inf.id}&pm_relevant=is.true&select=*&order=likes.desc&limit=${TOP_POSTS}`)) as PostDb[]
    const top = topN(relevant, TOP_POSTS)
    if (top.length) {
      await rest('POST', 'influencer_posts?on_conflict=run_id,influencer_id,post_id', top, 'resolution=merge-duplicates,return=minimal')
    }
    const est = estimateReactions(top, inf.max_reactions_per_post)
    estimate.push({ influencer_id: inf.id, slug: inf.slug, name: inf.name, posts: top.length, reactions: est.reactions, usd: est.usd })
  }
  const total = r4(estimate.reduce((s, e) => s + e.usd, 0))
  const reactions = estimate.reduce((s, e) => s + e.reactions, 0)
  ctx.run.counts = { ...ctx.run.counts, top_posts: estimate.reduce((s, e) => s + e.posts, 0), reactions_estimate: reactions }
  if (reactions === 0) {
    // Nothing to scrape: no approval to ask for.
    await patchRun(ctx, { stage: 'output', reactions_estimate: estimate, reactions_estimate_usd: 0, counts: ctx.run.counts })
    ctx.run.stage = 'output'
    return 'continue'
  }
  const ok = await patchRun(ctx, {
    status: 'awaiting_approval', stage: 'reactions', reactions_estimate: estimate, reactions_estimate_usd: total,
    awaiting_since: new Date().toISOString(), counts: ctx.run.counts, lease_token: null, lease_until: null,
  })
  if (ok) {
    const lines = estimate.filter((e) => e.reactions > 0).map((e) => `• ${e.name}: ${e.posts} posts, ${e.reactions} reactions, $${e.usd.toFixed(2)}`)
    await notify(ctx.run.id, 'influencer_reactions_bill', 'urgent',
      `PM influencer run: reactions bill ready, ${reactions} reactions for $${total.toFixed(2)}. Ask Lume to approve_reactions (or cancel).\n${lines.join('\n')}`)
  }
  return 'stop'
}

async function stageReactions(ctx: Ctx): Promise<StepResult> {
  const infl = await getInfluencers(ctx.run.influencer_ids)
  const est = ctx.run.reactions_estimate ?? []
  let rows = await getApifyRows(ctx.run.id, 'reactions')
  for (const inf of infl) {
    const e = est.find((x) => x.influencer_id === inf.id)
    if (!e || e.reactions <= 0 || rows.some((r) => r.influencer_id === inf.id)) continue
    if (ctx.deps.now() - ctx.startedAt > STEP_CUTOFF_MS) return 'continue'
    const top = (await rest('GET',
      `influencer_posts?run_id=eq.${ctx.run.id}&influencer_id=eq.${inf.id}&rank=not.is.null&select=post_url&order=rank`)) as { post_url: string }[]
    if (!top.length) continue
    const started = await startApify(ctx, inf, 'reactions', reactionsMaxChargeUsd(e.usd), buildReactionsInput(top.map((t) => t.post_url), inf.max_reactions_per_post))
    if (started === 'stopped') return 'stop'
  }
  rows = await getApifyRows(ctx.run.id, 'reactions')
  const bySlug = new Map(infl.map((i) => [i.id, i.slug]))
  const live = await pollApify(ctx, rows, async (row, items) => {
    const posts = (await rest('GET',
      `influencer_posts?run_id=eq.${ctx.run.id}&influencer_id=eq.${row.influencer_id}&rank=not.is.null&select=post_id,post_url`)) as { post_id: string; post_url: string }[]
    const merged = aggregateReactors(flattenReactions(items, Object.fromEntries(posts.map((p) => [p.post_id, p.post_url]))), bySlug.get(row.influencer_id) ?? '')
    const out = (await rpc('lume_influencer_merge_reactions', { p_apify_row: row.id, p_rows: merged })) as Record<string, unknown>
    if (out?.ok !== true) throw new Error(`merge failed: ${JSON.stringify(out).slice(0, 200)}`)
    if (out.already_ingested !== true) {
      addCount(ctx, 'new_reactors_merged', num(out.new_reactors))
      await patchRun(ctx, { counts: ctx.run.counts })
    }
  }, PRICE_PER_1K_REACTIONS)
  if (live || rows.some((r) => r.status === 'pending')) return 'wait'
  rows = await getApifyRows(ctx.run.id, 'reactions')
  if (rows.some((r) => r.status === 'running' || r.status === 'pending')) return 'wait'
  ctx.run.cost = { ...ctx.run.cost, apify_reactions: sumCost(rows) }
  ctx.run.counts = { ...ctx.run.counts, reactions: rows.reduce((s, r) => s + num(r.item_count), 0), reactions_failed: rows.filter((r) => r.status === 'failed').length }
  await patchRun(ctx, { stage: 'triage', cost: ctx.run.cost, counts: ctx.run.counts })
  ctx.run.stage = 'triage'
  return 'continue'
}

async function stageTriage(ctx: Ctx): Promise<StepResult> {
  const rows = (await rest('GET',
    `influencer_reactors?last_seen_run=eq.${ctx.run.id}&triage=is.null&select=id,headline&order=id&limit=${TRIAGE_BATCH}`)) as { id: number; headline: string | null }[]
  if (!rows.length) {
    await patchRun(ctx, { stage: 'verify' })
    ctx.run.stage = 'verify'
    return 'continue'
  }
  const { noCall, ask } = triageTodo(rows)
  const labels: Record<number, TriageLabel> = Object.fromEntries(noCall.map((id) => [id, 'no' as const]))
  if (ask.length) {
    const { json, usd } = await haiku(ctx, triageRequest(ask))
    addCost(ctx, 'anthropic', usd)
    Object.assign(labels, parseTriage(json, ask.map((r) => r.id)))
  }
  const now = new Date().toISOString()
  for (const label of ['likely', 'possible', 'no'] as const) {
    const ids = Object.entries(labels).filter(([, l]) => l === label).map(([id]) => Number(id))
    if (ids.length) await rest('PATCH', `influencer_reactors?id=in.${inList(ids)}&triage=is.null`, { triage: label, triaged_at: now, updated_at: now })
  }
  addCount(ctx, 'triaged', rows.length)
  await patchRun(ctx, { cost: ctx.run.cost, counts: ctx.run.counts })
  return 'continue'
}

interface VerifyRow {
  id: number
  name: string | null
  headline: string | null
  triage: string | null
  verdict: string | null
  verify_attempts: number
  company_name: string | null
  location: string | null
  door_count: number | null
  door_retried: boolean
  pplx_cost_usd: number | string
}

/** Perplexity with 5/10/20/40 s backoff on 429 / 5xx, while the wall clock allows. */
async function askPerplexity(ctx: Ctx, question: string): Promise<PplxAnswer> {
  if (!PERPLEXITY_API_KEY) throw new Error('PERPLEXITY_API_KEY is not set')
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(PPLX_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(perplexityRequest(question)),
      signal: AbortSignal.timeout(PPLX_TIMEOUT_MS),
    })
    if (res.ok) return parsePerplexity(await res.json())
    const text = (await res.text()).slice(0, 200)
    const wait = RETRY_BACKOFF_MS[attempt]
    const left = WALL_CLOCK_MS - (ctx.deps.now() - ctx.startedAt)
    if (!retryable(res.status) || wait === undefined || left < wait + PPLX_TIMEOUT_MS + HAIKU_TIMEOUT_MS + 10_000) {
      throw new Error(`Perplexity ${res.status}: ${text}`)
    }
    await ctx.deps.sleep(wait)
  }
}

function budgetLeft(ctx: Ctx): number {
  return num(ctx.run.max_verify_usd) - num(ctx.run.cost?.perplexity)
}

async function verifyOne(ctx: Ctx, r: VerifyRow): Promise<number> {
  const now = () => new Date().toISOString()
  let spent = 0
  try {
    const res = await askPerplexity(ctx, verificationQuestion(r.name ?? '', r.headline ?? ''))
    spent = res.cost
    const { json, usd } = await haiku(ctx, verifyParseRequest(r.name ?? '', r.headline ?? '', res.answer, res.citations))
    addCost(ctx, 'anthropic', usd)
    const p = groundDoorCount(parseVerifyJson(json), res.citations)
    await rest('PATCH', `influencer_reactors?id=eq.${r.id}`, {
      verdict: verdict(p), verify_attempts: r.verify_attempts + 1, verified_at: now(), verified_run: ctx.run.id,
      verify_reason: p.reason || null, title: p.title || null, company_name: p.company_name || null,
      company_website: p.company_website || null, location: p.location || null, city: p.city || null, state: p.state || null,
      country: p.country || null, door_count: p.door_count, door_count_source: p.door_count_source || null,
      door_count_confidence: p.door_count_confidence || null, citations: res.citations.slice(0, 20),
      pplx_cost_usd: r4(num(r.pplx_cost_usd) + spent), updated_at: now(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await rest('PATCH', `influencer_reactors?id=eq.${r.id}`, {
      verdict: 'error', verify_attempts: r.verify_attempts + 1, verify_reason: message.slice(0, 2000),
      verified_run: ctx.run.id, pplx_cost_usd: r4(num(r.pplx_cost_usd) + spent), updated_at: now(),
    })
  }
  return spent
}

async function doorOne(ctx: Ctx, r: VerifyRow): Promise<number> {
  let spent = 0
  const patch: Record<string, unknown> = { door_retried: true, updated_at: new Date().toISOString() }
  try {
    const res = await askPerplexity(ctx, doorQuestion(r.company_name ?? '', r.location ?? ''))
    spent = res.cost
    const { json, usd } = await haiku(ctx, verifyParseRequest(r.name ?? '', r.headline ?? '', res.answer, res.citations))
    addCost(ctx, 'anthropic', usd)
    const p = groundDoorCount(parseVerifyJson(json), res.citations)
    if (p.door_count !== null) {
      Object.assign(patch, { door_count: p.door_count, door_count_source: p.door_count_source, door_count_confidence: p.door_count_confidence })
    }
  } catch (err) {
    console.warn(`[${FN}] door retry ${r.id}:`, err instanceof Error ? err.message : err)
  }
  patch.pplx_cost_usd = r4(num(r.pplx_cost_usd) + spent)
  await rest('PATCH', `influencer_reactors?id=eq.${r.id}`, patch)
  return spent
}

const VERIFY_COLS = 'id,name,headline,triage,verdict,verify_attempts,company_name,location,door_count,door_retried,pplx_cost_usd'

async function stageVerify(ctx: Ctx, doors: boolean): Promise<StepResult> {
  const next = doors ? 'output' : 'doors'
  if (budgetLeft(ctx) < PPLX_RESERVE_PER_CALL * VERIFY_WORKERS) {
    ctx.run.counts = { ...ctx.run.counts, verify_capped: true }
    await patchRun(ctx, { stage: 'output', counts: ctx.run.counts })
    ctx.run.stage = 'output'
    return 'continue'
  }
  const filter = doors
    ? `verdict=eq.verified&door_count=is.null&company_name=not.is.null&door_retried=is.false`
    : `triage=in.(likely,possible)&or=(verdict.is.null,and(verdict.eq.error,verify_attempts.lt.${MAX_VERIFY_ATTEMPTS}))`
  const rows = (await rest('GET',
    `influencer_reactors?last_seen_run=eq.${ctx.run.id}&${filter}&select=${VERIFY_COLS}&order=influencer_count.desc,reaction_count.desc,id&limit=${VERIFY_WORKERS}`)) as VerifyRow[]
  if (!rows.length) {
    await patchRun(ctx, { stage: next })
    ctx.run.stage = next
    return 'continue'
  }
  const spent = await Promise.all(rows.map((r) => (doors ? doorOne(ctx, r) : verifyOne(ctx, r))))
  addCost(ctx, 'perplexity', spent.reduce((s, x) => s + x, 0))
  addCount(ctx, doors ? 'door_retries' : 'verify_calls', rows.length)
  await patchRun(ctx, { cost: ctx.run.cost, counts: ctx.run.counts })
  return 'continue'
}

async function readAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; offset < 200_000; offset += 1000) {
    const page = (await rest('GET', `${path}&limit=1000&offset=${offset}`)) as T[]
    out.push(...page)
    if (page.length < 1000) break
  }
  return out
}

async function stageOutput(ctx: Ctx): Promise<StepResult> {
  const infl = await getInfluencers(ctx.run.influencer_ids)
  const reactors = await readAll<StatReactor>(
    `influencer_reactors?last_seen_run=eq.${ctx.run.id}&select=reacted_to,triage,verdict,door_count,pplx_cost_usd,influencer_count,first_seen_run,verified_run&order=id`)
  const apifyRows = (await rest('GET', `influencer_apify_runs?run_id=eq.${ctx.run.id}&select=influencer_id,kind,status,cost_usd,item_count`)) as
    { influencer_id: string; kind: string; status: string; cost_usd: number; item_count: number | null }[]
  const posts = infl.map((inf) => ({
    influencer_id: inf.id,
    posts: num(apifyRows.find((a) => a.influencer_id === inf.id && a.kind === 'posts')?.item_count),
    top: num(ctx.run.reactions_estimate?.find((e) => e.influencer_id === inf.id)?.posts),
  }))
  const counts: Record<string, unknown> = { ...ctx.run.counts, ...runCounts(ctx.run.id, reactors) }
  const cost = { ...ctx.run.cost }
  cost.total = r4(num(cost.apify_posts) + num(cost.apify_reactions) + num(cost.perplexity) + num(cost.anthropic))
  const now = new Date().toISOString()
  for (const s of influencerStats(ctx.run.id, infl, reactors, apifyRows, posts, num(cost.anthropic))) {
    const { id, slug: _slug, ...stats } = s
    await rest('PATCH', `influencers?id=eq.${id}`, { ...stats, last_ran_at: now, updated_at: now })
  }
  const ok = await patchRun(ctx, { status: 'done', stage: 'output', counts, cost, finished_at: now, lease_token: null, lease_until: null })
  if (ok) {
    await notify(ctx.run.id, 'influencer_run_done', 'info',
      `PM influencer run done: ${String(counts.verified)} verified decision-makers (${String(counts.leads_700)} at 700+ doors), ` +
      `${String(counts.new_reactors)} new reactors of ${String(counts.unique_reactors)}; spent $${cost.total.toFixed(2)}` +
      `${counts.verify_capped ? ' (Perplexity cap reached; some candidates unverified)' : ''}. Ask Lume for the Apollo CSV.`)
  }
  return 'stop'
}

function step(ctx: Ctx): Promise<StepResult> {
  switch (ctx.run.stage) {
    case 'posts': return stagePosts(ctx)
    case 'top_posts': return stageTopPosts(ctx)
    case 'reactions': return stageReactions(ctx)
    case 'triage': return stageTriage(ctx)
    case 'verify': return stageVerify(ctx, false)
    case 'doors': return stageVerify(ctx, true)
    case 'output': return stageOutput(ctx)
    default: throw new Error(`unknown stage ${ctx.run.stage}`)
  }
}

// ---------------------------------------------------------------------------
// the chain

async function selfInvoke(runId: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${FN}`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: runId, prev: token }),
        signal: AbortSignal.timeout(HANDOFF_MS),
      })
      await res.body?.cancel()
      if (res.ok) return true
    } catch (err) {
      console.error(`[${FN}] hand-off attempt ${attempt + 1} threw:`, err)
    }
    await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)))
  }
  return false
}

/** Claim the run and work in steps until it stops, waits past the cutoff, or the cutoff hits; then hand off. */
export async function advance(runId: string, prev: string | null, deps: Deps = {}): Promise<void> {
  const d = { ...deps, now: deps.now ?? Date.now, sleep: deps.sleep ?? defaultSleep }
  const startedAt = deps.startedAt ?? d.now()
  const token = crypto.randomUUID()
  const claimed = (await rpc('lume_influencer_claim_run', { p_run: runId, p_prev: prev, p_token: token, p_lease_seconds: 170 })) as Run[]
  const run = Array.isArray(claimed) ? claimed[0] : null
  if (!run) {
    console.log(`[${FN}] run ${runId}: not claimable (not running, or another invocation holds it)`)
    return
  }
  const ctx: Ctx = { run: { ...run, counts: run.counts ?? {}, cost: run.cost ?? {} }, deps: d, startedAt, token }
  try {
    while (true) {
      if (d.now() - startedAt > STEP_CUTOFF_MS) break
      const r = await step(ctx)
      // A step that went through ends a streak of transient errors (persisted with the next write).
      if (num(ctx.run.counts?.transient_streak) > 0) ctx.run.counts = { ...ctx.run.counts, transient_streak: 0 }
      if (r === 'stop') return
      // Cancelled meanwhile, or the lease was lost: stop without touching the run.
      const fresh = (await rpc('lume_influencer_claim_run', { p_run: runId, p_prev: token, p_token: token, p_lease_seconds: 170 })) as Run[]
      if (!Array.isArray(fresh) || !fresh.length) return
      if (r === 'wait') {
        if (d.now() - startedAt + POLL_SLEEP_MS > STEP_CUTOFF_MS) break
        await d.sleep(POLL_SLEEP_MS)
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const transient = err instanceof TransientError || (err instanceof RestError && err.status >= 500)
    const streak = num(ctx.run.counts?.transient_streak) + 1
    if (!transient || streak >= MAX_TRANSIENT_STREAK) {
      await failRun(runId, `${ctx.run.stage}: ${message}${transient ? ` (${streak} transient errors in a row)` : ''}`)
      return
    }
    // Transient: keep the run running; the next invocation retries this step.
    console.warn(`[${FN}] run ${runId} transient error ${streak} in ${ctx.run.stage}:`, message)
    ctx.run.counts = { ...ctx.run.counts, transient_streak: streak, last_transient_error: `${ctx.run.stage}: ${message}`.slice(0, 300) }
    await patchRun(ctx, { counts: ctx.run.counts }).catch(() => undefined)
    if (d.now() - startedAt + TRANSIENT_PAUSE_MS < WALL_CLOCK_MS - HANDOFF_MS * 2) await d.sleep(TRANSIENT_PAUSE_MS)
  }
  const handed = await (deps.handOff ?? selfInvoke)(runId, token)
  if (!handed) await notify(runId, 'influencer_run_handoff', 'warn', 'PM influencer run: could not start the next chunk after 4 attempts; the stale sweep will fail it in 30 minutes.')
}

/**
 * A fatal error: fail the run AND its pending/running Apify rows in one
 * statement (lume_influencer_fail_run), abort those runs on Apify and ping
 * the owner. Their reservations stay as their cost and leave the shared
 * budget's reserved sum 10 minutes later, like any finished row.
 */
async function failRun(runId: string, error: string): Promise<void> {
  console.error(`[${FN}] run ${runId} failed:`, error)
  try {
    const out = (await rpc('lume_influencer_fail_run', { p_run: runId, p_error: error.slice(0, 2000) })) as { ok?: boolean; abort?: string[] }
    if (out?.ok) await abortApify(out.abort ?? [])
  } catch (e) {
    // The sweep closes the rows (parent run no longer active / max run age) on a later invocation.
    console.error(`[${FN}] could not fail run ${runId}:`, e)
  }
  await notify(runId, 'influencer_run_failed', 'warn', `PM influencer run failed: ${error.slice(0, 300)}`)
}

async function abortApify(ids: (string | null)[]): Promise<void> {
  await Promise.all(ids.filter((id): id is string => !!id).map(async (id) => {
    try {
      const res = await apify(`/actor-runs/${encodeURIComponent(id)}/abort`, { method: 'POST' })
      await res.body?.cancel()
      if (!res.ok) console.warn(`[${FN}] abort of ${id} answered ${res.status}`)
    } catch (err) {
      console.warn(`[${FN}] abort of ${id} failed:`, err)
    }
  }))
}

async function sweepStale(): Promise<void> {
  try {
    // Stale chains, hung or never-started Apify rows, rows under a finished run, max run age, expired approvals.
    const rows = (await rpc('lume_influencer_sweep', { p_stale_minutes: STALE_MINUTES })) as { run_id: string; apify_run_id: string | null }[]
    if (Array.isArray(rows) && rows.length) await abortApify(rows.map((r) => r.apify_run_id))
  } catch (err) {
    console.error(`[${FN}] stale sweep failed:`, err)
  }
}

// ---------------------------------------------------------------------------
// entry

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

function maxVerify(v: unknown): number | null {
  if (v === undefined || v === null) return MAX_VERIFY_USD_DEFAULT
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= MAX_VERIFY_USD_LIMIT ? Math.round(n * 100) / 100 : null
}

async function start(body: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void, deps: Deps): Promise<Response> {
  if (!APIFY_API_TOKEN) return reply({ error: 'apify_not_configured' }, 503)
  if (!ANTHROPIC_API_KEY) return reply({ error: 'anthropic_not_configured' }, 503)
  if (!PERPLEXITY_API_KEY) return reply({ error: 'perplexity_not_configured' }, 503)
  const ids = Array.isArray(body.influencer_ids) ? [...new Set(body.influencer_ids.map((x) => String(x).toLowerCase()))] : []
  if (!ids.length || ids.length > 100 || !ids.every(isUuid)) return reply({ error: 'bad_influencer_ids' }, 400)
  const cap = maxVerify(body.max_verify_usd)
  if (cap === null) return reply({ error: 'bad_max_verify_usd' }, 400)
  if (body.start_action_id !== undefined && !isUuid(body.start_action_id)) return reply({ error: 'bad_start_action_id' }, 400)
  if (body.start_action_id) {
    const existing = (await rest('GET', `influencer_runs?start_action_id=eq.${body.start_action_id}&select=id,status`)) as { id: string; status: string }[]
    if (existing.length) return reply({ ok: true, run_id: existing[0].id, status: existing[0].status, existing: true }, 200)
  }
  const infl = (await rest('GET', `influencers?id=in.${inList(ids)}&active=is.true&select=id`)) as { id: string }[]
  if (infl.length !== ids.length) return reply({ error: 'influencer_not_found_or_inactive' }, 400)
  let created: { id: string }[]
  try {
    created = (await rest('POST', 'influencer_runs', {
      influencer_ids: ids, max_verify_usd: cap, start_action_id: body.start_action_id ?? null, status: 'running', stage: 'posts',
      estimate: body.estimate && typeof body.estimate === 'object' && !Array.isArray(body.estimate) ? body.estimate : {},
    }, 'return=representation')) as { id: string }[]
  } catch (err) {
    if (err instanceof RestError && err.status === 409) return reply({ error: 'run_in_progress' }, 409)
    throw err
  }
  const runId = created[0].id
  waitUntil(advance(runId, null, deps))
  return reply({ ok: true, run_id: runId, status: 'running', stage: 'posts' }, 202)
}

async function approveReactions(body: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void, deps: Deps): Promise<Response> {
  if (!isUuid(body.run_id)) return reply({ error: 'bad_run_id' }, 400)
  const approved = Number(body.approved_usd)
  if (!Number.isFinite(approved) || approved < 0) return reply({ error: 'bad_approved_usd' }, 400)
  if (body.reactions_action_id !== undefined && !isUuid(body.reactions_action_id)) return reply({ error: 'bad_reactions_action_id' }, 400)
  const capPatch: Record<string, unknown> = {}
  if (body.max_verify_usd !== undefined) {
    const cap = maxVerify(body.max_verify_usd)
    if (cap === null) return reply({ error: 'bad_max_verify_usd' }, 400)
    capPatch.max_verify_usd = cap
  }
  // The bill the owner approved must still cover the bill on the run.
  const rows = (await rest('PATCH',
    `influencer_runs?id=eq.${body.run_id}&status=eq.awaiting_approval&stage=eq.reactions&reactions_estimate_usd=lte.${approved}`,
    {
      status: 'running', approved_at: new Date().toISOString(), reactions_approved_usd: approved,
      reactions_action_id: body.reactions_action_id ?? null, updated_at: new Date().toISOString(), ...capPatch,
    }, 'return=representation')) as unknown[]
  if (!Array.isArray(rows) || !rows.length) {
    const run = await getRun(body.run_id)
    return reply({ error: 'not_awaiting_or_bill_changed', status: run?.status ?? null, stage: run?.stage ?? null, reactions_estimate_usd: run?.reactions_estimate_usd ?? null }, 409)
  }
  waitUntil(advance(body.run_id, null, deps))
  return reply({ ok: true, run_id: body.run_id, status: 'running', stage: 'reactions' }, 202)
}

async function cancel(body: Record<string, unknown>): Promise<Response> {
  if (!isUuid(body.run_id)) return reply({ error: 'bad_run_id' }, 400)
  const out = (await rpc('lume_influencer_cancel_run', { p_run: body.run_id })) as { ok?: boolean; error?: string; abort?: string[] }
  if (!out?.ok) return reply({ error: out?.error ?? 'cancel_failed' }, 409)
  await abortApify(out.abort ?? [])
  return reply({ ok: true, run_id: body.run_id, aborted: out.abort?.length ?? 0 }, 200)
}

export async function handle(
  req: Request,
  waitUntil: (p: Promise<unknown>) => void = (p) => EdgeRuntime.waitUntil(p),
  deps: Deps = {},
): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  deps = { ...deps, startedAt: deps.startedAt ?? (deps.now ?? Date.now)() }
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!(await secretsMatch(token, SUPABASE_SERVICE_ROLE_KEY))) return reply({ error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return reply({ error: 'invalid_json' }, 400)
  }

  waitUntil(sweepStale())
  try {
    switch (body.action) {
      case 'start': return await start(body, waitUntil, deps)
      case 'approve_reactions': return await approveReactions(body, waitUntil, deps)
      case 'cancel': return await cancel(body)
      case undefined: {
        if (!isUuid(body.run_id) || !isUuid(body.prev)) return reply({ error: 'bad_continue' }, 400)
        waitUntil(advance(body.run_id, body.prev, deps))
        return reply({ ok: true, run_id: body.run_id }, 202)
      }
      default: return reply({ error: 'unknown_action' }, 400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${FN}] ${String(body.action ?? 'continue')} failed:`, message)
    return reply({ error: 'internal_error', detail: message.slice(0, 300) }, 500)
  }
}

Deno.serve((req) => handle(req))
