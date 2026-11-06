// Supabase Edge Function: influencer-lookup — find the LinkedIn profiles of a
// staged list of influencer candidates (Lume: import_influencer_candidates ->
// an approved `influencer_lookup` pending action -> here).
//
// POST { action: 'start', batch_id, max_usd, action_id }
//        only from the executor of the owner-approved lookup: flips the batch
//        staged | capped -> looking_up with the cap (what was already spent +
//        max_usd, at most $50) and starts the chain.
// POST { action: 'continue', batch_id, prev }   internal: the hand-off chain.
// POST { action: 'sweep' }                       the 5-minute pg_cron sweep
//        (lume_influencer_lookup_sweep_tick): re-kicks looking_up batches
//        whose lease expired (a chain that died mid-way).
//
// Caller: service role only (isServiceCaller); this function spends money.
//
// Per candidate (2 workers, like the reactions pipeline's verify stage):
// Perplexity Sonar asks for the linkedin.com/in profile from the name, title
// and company (5/10/20/40 s backoff on 429 / 5xx); Haiku JSON picks the URL
// from the NUMBERED SOURCES Perplexity returned; groundLookup keeps it only
// when it is one of those cited sources and the cited material ties it to the
// person and their company or role (_shared/influencer/lookup.ts). A found URL
// that is already an influencer marks the candidate 'duplicate'. Two failed
// attempts give up as not_found with the error.
//
// Spend: before each pair, what is left of max_lookup_usd must cover them at
// LOOKUP_USD_PER_PERSON each; otherwise the batch stops as 'capped' (the
// owner can approve more). Memory: candidates are read two at a time, never
// the whole batch. Resumable: a pair starts only while at least 75 s of the
// 150 s wall clock remain (a pair can take ~70 s with retries), under a lease
// (lease_token / lease_until on the batch); then it hands off to a fresh one.
// Defence in depth on start: the action_id must be an approved / executing
// influencer_lookup for THIS batch, and an action that already ran the batch
// is never used again.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }
import { alert, gateKey, lumeLink } from '../_shared/alert.ts'
import { isServiceCaller } from '../_shared/lume/serviceAuth.ts'
import { haikuUsd } from '../_shared/influencer/cost.ts'
import { parseJsonResponse, type JsonRequest } from '../_shared/influencer/haiku.ts'
import {
  groundLookup,
  LOOKUP_USD_PER_PERSON,
  lookupParseRequest,
  lookupRequest,
  MAX_LOOKUP_ATTEMPTS,
  normalizeLinkedinUrl,
  parseLookupJson,
  parseLookupResponse,
  type LookupCandidate,
} from '../_shared/influencer/lookup.ts'
import { PPLX_URL, RETRY_BACKOFF_MS, retryable, VERIFY_WORKERS } from '../_shared/influencer/verify.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const PERPLEXITY_API_KEY = Deno.env.get('PERPLEXITY_API_KEY') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const FN = 'influencer-lookup'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
/** The edge wall clock per invocation. */
export const WALL_CLOCK_MS = 150_000
/** Start a pair only with this much wall clock left (Perplexity 40 s + Haiku 30 s per call, worst case, plus the save). */
export const MIN_LEFT_FOR_PAIR_MS = 75_000
/** A lease outlives one invocation; the sweep re-kicks a batch after it expires. */
const LEASE_MS = 3 * 60_000
const PPLX_TIMEOUT_MS = 40_000
const HAIKU_TIMEOUT_MS = 30_000
export const MAX_CAP_USD = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Deps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  handOff?: (batchId: string, token: string) => Promise<boolean>
  /** The chain itself (tests replace it to check that start / sweep kick it). */
  run?: (batchId: string, prev: string | null) => Promise<void>
}

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
}

async function rest(method: string, path: string, body?: unknown, representation = false): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...REST_HEADERS, 'Prefer': representation ? 'return=representation' : 'return=minimal' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : null
}

const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const round4 = (n: number) => Math.round(n * 10_000) / 10_000
const iso = (ms: number) => new Date(ms).toISOString()
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

function notify(batchId: string, kind: string, text: string): Promise<unknown> {
  const link = lumeLink('/influencers')
  return alert({
    source: FN, severity: 'info', title: text.split('\n')[0].slice(0, 120), body: text.slice(0, 2000), link, scope: 'orders',
    dedupe_key: gateKey(batchId, kind),
    telegram: () => sendTelegram(`${text}${link.startsWith('http') ? `\n${link}` : ''}`),
  }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// vendors

interface Ctx {
  batchId: string
  token: string
  startedAt: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** linkedin.com/in URL (normalised) -> influencer id, read once per invocation. */
  existing: Map<string, string> | null
}

async function askPerplexity(ctx: Ctx, c: LookupCandidate) {
  if (!PERPLEXITY_API_KEY) throw new Error('PERPLEXITY_API_KEY is not set')
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(PPLX_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(lookupRequest(c)),
      signal: AbortSignal.timeout(PPLX_TIMEOUT_MS),
    })
    if (res.ok) return parseLookupResponse(await res.json())
    const text = (await res.text()).slice(0, 200)
    const wait = RETRY_BACKOFF_MS[attempt]
    const left = WALL_CLOCK_MS - (ctx.now() - ctx.startedAt)
    if (!retryable(res.status) || wait === undefined || left < wait + PPLX_TIMEOUT_MS + HAIKU_TIMEOUT_MS + 5_000) throw new Error(`Perplexity ${res.status}: ${text}`)
    await ctx.sleep(wait)
  }
}

async function haiku(req: JsonRequest): Promise<{ json: unknown; usd: number }> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(HAIKU_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Haiku ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const { json, usage } = parseJsonResponse(await res.json())
  return { json, usd: haikuUsd(usage) }
}

async function existingInfluencers(ctx: Ctx): Promise<Map<string, string>> {
  if (ctx.existing) return ctx.existing
  const rows = (await rest('GET', 'influencers?select=id,linkedin_url')) as { id: string; linkedin_url: string }[] | null
  ctx.existing = new Map()
  for (const r of rows ?? []) {
    const u = normalizeLinkedinUrl(r.linkedin_url)
    if (u) ctx.existing.set(u, r.id)
  }
  return ctx.existing
}

interface Candidate { id: string; name: string; title: string | null; company: string | null; lookup_attempts: number }

/** One person: lookup, grounding, duplicate check, one conditional PATCH (only while still pending). What it cost. */
async function lookupOne(ctx: Ctx, c: Candidate): Promise<number> {
  let spent = 0
  const attempts = num(c.lookup_attempts) + 1
  const at = iso(ctx.now())
  const save = (patch: Record<string, unknown>) =>
    rest('PATCH', `influencer_candidates?id=eq.${c.id}&status=eq.pending_lookup`, { ...patch, lookup_attempts: attempts, updated_at: at })
  try {
    const answer = await askPerplexity(ctx, c)
    spent += answer.cost
    const { json, usd } = await haiku(lookupParseRequest(c, answer.answer, answer.sources))
    spent += usd
    const g = groundLookup(c, parseLookupJson(json), answer.sources, answer.answer)
    const dupe = g.linkedin_url ? (await existingInfluencers(ctx)).get(g.linkedin_url) : undefined
    await save({
      status: dupe ? 'duplicate' : g.status,
      confidence: g.confidence,
      linkedin_url: g.linkedin_url,
      evidence: g.evidence,
      lookup_usd: round4(spent),
      lookup_error: null,
      ...(dupe ? { influencer_id: dupe } : {}),
    })
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000)
    const giveUp = attempts >= MAX_LOOKUP_ATTEMPTS
    await save({ lookup_error: message, lookup_usd: round4(spent), ...(giveUp ? { status: 'not_found', confidence: 'not_found' } : {}) }).catch((e) =>
      console.error(`[${FN}] candidate ${c.id} save failed:`, e)
    )
  }
  return spent
}

// ---------------------------------------------------------------------------
// the chain

async function selfInvoke(batchId: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${FN}`, {
        method: 'POST',
        headers: { ...REST_HEADERS },
        body: JSON.stringify({ action: 'continue', batch_id: batchId, prev: token }),
        signal: AbortSignal.timeout(10_000),
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

const batchPath = (id: string) => `influencer_candidate_batches?id=eq.${id}`

/** Claim the batch's lease, look people up until done / capped / out of time, then hand off. */
export async function runBatch(batchId: string, prev: string | null, deps: Deps = {}): Promise<void> {
  const now = deps.now ?? Date.now
  const ctx: Ctx = { batchId, token: crypto.randomUUID(), startedAt: now(), now, sleep: deps.sleep ?? defaultSleep, existing: null }
  const free = `or=(lease_until.is.null,lease_until.lt.${encodeURIComponent(iso(now()))}${prev && UUID_RE.test(prev) ? `,lease_token.eq.${prev}` : ''})`
  const claimed = (await rest('PATCH', `${batchPath(batchId)}&status=eq.looking_up&${free}`, { lease_token: ctx.token, lease_until: iso(now() + LEASE_MS) }, true)) as Record<string, unknown>[] | null
  const batch = claimed?.[0]
  if (!batch) return // someone else holds it, or it is no longer looking up
  const cap = num(batch.max_lookup_usd)
  let spent = num(batch.spent_usd)
  const mine = `${batchPath(batchId)}&lease_token=eq.${ctx.token}`
  const finish = async (status: 'done' | 'capped') => {
    await rest('PATCH', mine, { status, spent_usd: round4(spent), lease_token: null, lease_until: null, updated_at: iso(now()) }, true)
    await notify(batchId, `lookup_${status}`, status === 'done'
      ? `Influencer lookup finished ($${spent.toFixed(2)} spent). Review the candidates in Lume.`
      : `Influencer lookup stopped at its $${cap.toFixed(2)} cap with people still to look up. Approve more in Lume to continue.`)
  }

  while (WALL_CLOCK_MS - (now() - ctx.startedAt) >= MIN_LEFT_FOR_PAIR_MS) {
    const rows = (await rest('GET', `influencer_candidates?batch_id=eq.${batchId}&status=eq.pending_lookup&lookup_attempts=lt.${MAX_LOOKUP_ATTEMPTS}&order=row_index&limit=${VERIFY_WORKERS}&select=id,name,title,company,lookup_attempts`)) as Candidate[] | null
    if (!rows?.length) return finish('done')
    const affordable = Math.floor((cap - spent + 1e-9) / LOOKUP_USD_PER_PERSON)
    if (affordable <= 0) return finish('capped')
    const costs = await Promise.all(rows.slice(0, affordable).map((c) => lookupOne(ctx, c)))
    spent += costs.reduce((a, b) => a + b, 0)
    const still = (await rest('PATCH', mine, { spent_usd: round4(spent), lease_until: iso(now() + LEASE_MS), updated_at: iso(now()) }, true)) as unknown[] | null
    if (!still?.length) return // lease lost (cancelled or taken over): stop without touching anything else
  }
  const handed = await (deps.handOff ?? selfInvoke)(batchId, ctx.token)
  // A failed hand-off: let the lease lapse now so the 5-minute sweep picks the batch up.
  if (!handed) await rest('PATCH', mine, { lease_until: iso(now() - 1000) }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// actions

async function start(body: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void, deps: Deps): Promise<Response> {
  const batchId = String(body.batch_id ?? '')
  const actionId = String(body.action_id ?? '')
  const maxUsd = Number(body.max_usd)
  if (!UUID_RE.test(batchId) || !UUID_RE.test(actionId) || !(maxUsd > 0) || maxUsd > MAX_CAP_USD) return reply({ error: 'bad_start' }, 400)
  if (!PERPLEXITY_API_KEY) return reply({ error: 'perplexity_not_configured' }, 503)
  if (!ANTHROPIC_API_KEY) return reply({ error: 'anthropic_not_configured' }, 503)
  const rows = (await rest('GET', `${batchPath(batchId)}&select=id,status,spent_usd,lookup_action_id`)) as Record<string, unknown>[] | null
  const b = rows?.[0]
  if (!b) return reply({ error: 'batch_not_found' }, 404)
  const run = deps.run ?? ((id: string, prev: string | null) => runBatch(id, prev, deps))
  // Defence in depth: only an owner-approved influencer_lookup for this very batch may start it.
  const actions = (await rest('GET', `pending_actions?id=eq.${actionId}&select=kind,status,payload`)) as { kind: string; status: string; payload: Record<string, unknown> | null }[] | null
  const action = actions?.[0]
  if (!action || action.kind !== 'influencer_lookup' || !['approved', 'executing'].includes(action.status) || action.payload?.batch_id !== batchId) {
    return reply({ error: 'action_not_approved' }, 403)
  }
  if (b.lookup_action_id === actionId) {
    // A retried start for the same approval while it runs: nothing new. After it ran: never a second spend.
    return b.status === 'looking_up' ? reply({ ok: true, batch_id: batchId, already: true }, 202) : reply({ error: 'action_already_used', status: b.status }, 409)
  }
  if (b.status !== 'staged' && b.status !== 'capped') return reply({ error: 'not_startable', status: b.status }, 409)
  const cap = Math.min(MAX_CAP_USD, round4(num(b.spent_usd) + maxUsd))
  const flipped = (await rest('PATCH', `${batchPath(batchId)}&status=eq.${b.status}`, {
    status: 'looking_up', max_lookup_usd: cap, lookup_action_id: actionId, lease_token: null, lease_until: null, error: null, updated_at: new Date().toISOString(),
  }, true)) as unknown[] | null
  if (!flipped?.length) return reply({ error: 'conflict' }, 409)
  waitUntil(run(batchId, null))
  return reply({ ok: true, batch_id: batchId, max_lookup_usd: cap }, 202)
}

async function sweep(waitUntil: (p: Promise<unknown>) => void, deps: Deps): Promise<Response> {
  const rows = (await rest('GET', `influencer_candidate_batches?status=eq.looking_up&or=(lease_until.is.null,lease_until.lt.${encodeURIComponent(new Date().toISOString())})&select=id&limit=5`)) as { id: string }[] | null
  const run = deps.run ?? ((id: string, prev: string | null) => runBatch(id, prev, deps))
  for (const r of rows ?? []) waitUntil(run(r.id, null))
  return reply({ ok: true, kicked: rows?.length ?? 0 }, 200)
}

export async function handle(
  req: Request,
  waitUntil: (p: Promise<unknown>) => void = (p) => EdgeRuntime.waitUntil(p),
  deps: Deps = {},
): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  if (!(await isServiceCaller(req))) return reply({ error: 'unauthorized' }, 401)
  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return reply({ error: 'invalid_json' }, 400)
  }
  try {
    switch (body.action) {
      case 'start': return await start(body, waitUntil, deps)
      case 'sweep': return await sweep(waitUntil, deps)
      case 'continue': {
        if (!UUID_RE.test(String(body.batch_id)) || !UUID_RE.test(String(body.prev))) return reply({ error: 'bad_continue' }, 400)
        const run = deps.run ?? ((id: string, prev: string | null) => runBatch(id, prev, deps))
        waitUntil(run(String(body.batch_id), String(body.prev)))
        return reply({ ok: true }, 202)
      }
      default: return reply({ error: 'unknown_action' }, 400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${FN}] ${String(body.action)} failed:`, message)
    return reply({ error: 'internal_error', detail: message.slice(0, 300) }, 500)
  }
}

Deno.serve((req) => handle(req))
