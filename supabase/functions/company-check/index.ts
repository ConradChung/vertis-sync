// Supabase Edge Function: company-check — what each company in a validation
// job really does and whether it fits the ICP (Lume: get_company_check quotes
// the price -> an approved `company_check` pending action -> here).
//
// POST { action: 'start', job_id, max_usd, action_id }
//        only from the executor of the owner-approved check: opens (or
//        reuses) the run for the job + the action's ICP + the action's scope
//        ('all' valid rows, or 'sending': only those still queued / active in
//        the lead bank; payload.scope, default 'all'), seeds its distinct
//        companies from the job's valid rows (company_check_seed: deduped by
//        domain, cached ones marked), raises the cap to what was already spent
//        + max_usd, flips it to running and starts the chain.
// POST { action: 'continue', run_id, prev }   internal: the hand-off chain.
// POST { action: 'sweep' }                     the 5-minute pg_cron sweep
//        (lume_company_check_sweep_tick): re-kicks running runs whose lease
//        expired (a chain that died mid-way).
//
// Caller: service role only (isServiceCaller); this function spends money.
//
// Per company (2 workers, Perplexity 429s above ~2 concurrent): the cache is
// checked first (company_checks by company_key + icp_key: a hit costs
// nothing); otherwise Perplexity Sonar researches the company
// (_shared/company_check/check.ts, the influencer verify request shape) and
// Haiku turns the answer into what_it_does / icp_fit / confidence / evidence
// / property_type / doors (one Perplexity call answers all of them), grounded on the cited sources. The verdict is upserted into the cache, the
// item marked done with its real cost. Two failed attempts mark it error.
//
// Spend: before each pair, what is left of max_usd must cover them at
// CHECK_USD_PER_COMPANY each; otherwise the run stops as 'capped' (the owner
// can approve more). Real costs (Perplexity usage.cost, Haiku usage tokens)
// are tallied into spent_usd. Resumable: a pair starts only while at least
// 75 s of the 150 s wall clock remain, under a lease; then it hands off.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }
import { alert, gateKey, lumeLink } from '../_shared/alert.ts'
import { isServiceCaller } from '../_shared/lume/serviceAuth.ts'
import { haikuUsd } from '../_shared/influencer/cost.ts'
import { parseJsonResponse, type JsonRequest } from '../_shared/influencer/haiku.ts'
import { PPLX_URL, RETRY_BACKOFF_MS, retryable, VERIFY_WORKERS } from '../_shared/influencer/verify.ts'
import {
  CHECK_USD_PER_COMPANY,
  checkParseRequest,
  checkRequest,
  groundCheck,
  MAX_APPROVAL_USD,
  MAX_CHECK_ATTEMPTS,
  parseCheckJson,
  parsePerplexity,
  type CheckCompany,
} from '../_shared/company_check/check.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const PERPLEXITY_API_KEY = Deno.env.get('PERPLEXITY_API_KEY') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const FN = 'company-check'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
export const WALL_CLOCK_MS = 150_000
/** Start a pair only with this much wall clock left (Perplexity 40 s + Haiku 30 s worst case, plus the saves). */
export const MIN_LEFT_FOR_PAIR_MS = 75_000
const LEASE_MS = 3 * 60_000
const PPLX_TIMEOUT_MS = 40_000
const HAIKU_TIMEOUT_MS = 30_000
const SCOPES = new Set(['all', 'sending'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Deps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  handOff?: (runId: string, token: string) => Promise<boolean>
  run?: (runId: string, prev: string | null) => Promise<void>
}

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
}

async function rest(method: string, path: string, body?: unknown, prefer = 'return=minimal'): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...REST_HEADERS, 'Prefer': prefer },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : null
}
const rep = 'return=representation'
const rpc = (fn: string, args: Record<string, unknown>) => rest('POST', `rpc/${fn}`, args, rep)

const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const enc = encodeURIComponent
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

function notify(runId: string, kind: string, text: string): Promise<unknown> {
  const link = lumeLink('/progress')
  return alert({
    source: FN, severity: 'info', title: text.split('\n')[0].slice(0, 120), body: text.slice(0, 2000), link, scope: 'validation',
    dedupe_key: gateKey(runId, kind),
    telegram: () => sendTelegram(`${text}${link.startsWith('http') ? `\n${link}` : ''}`),
  }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// vendors

interface Ctx { runId: string; icp: string; icpKey: string; token: string; startedAt: number; now: () => number; sleep: (ms: number) => Promise<void> }

async function askPerplexity(ctx: Ctx, c: CheckCompany) {
  if (!PERPLEXITY_API_KEY) throw new Error('PERPLEXITY_API_KEY is not set')
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(PPLX_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(checkRequest(c, ctx.icp)),
      signal: AbortSignal.timeout(PPLX_TIMEOUT_MS),
    })
    if (res.ok) return parsePerplexity(await res.json())
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

interface Item extends CheckCompany { attempts: number }

/** One company: cache hit (free) or research + parse + cache upsert; one conditional PATCH of the item. What it cost. */
async function checkOne(ctx: Ctx, it: Item): Promise<number> {
  const at = iso(ctx.now())
  const itemPath = `company_check_items?run_id=eq.${ctx.runId}&company_key=eq.${enc(it.company_key)}&status=eq.pending`
  const cached = (await rest('GET', `company_checks?company_key=eq.${enc(it.company_key)}&icp_key=eq.${ctx.icpKey}&select=id&limit=1`)) as unknown[] | null
  if (cached?.length) {
    await rest('PATCH', itemPath, { status: 'cached', updated_at: at })
    return 0
  }
  let spent = 0
  const attempts = num(it.attempts) + 1
  try {
    const answer = await askPerplexity(ctx, it)
    spent += answer.cost
    const { json, usd } = await haiku(checkParseRequest(it, ctx.icp, answer.answer, answer.citations))
    spent += usd
    const r = groundCheck(parseCheckJson(json), answer.citations)
    await rest('POST', 'company_checks?on_conflict=company_key,icp_key', {
      company_key: it.company_key, icp_key: ctx.icpKey, company_name: it.company_name, website: it.website,
      what_it_does: r.what_it_does, icp_fit: r.icp_fit, confidence: r.confidence, evidence: r.evidence, evidence_url: r.evidence_url,
      property_type: r.property_type, doors: r.doors, doors_evidence: r.doors_evidence || null,
      citations: answer.citations.slice(0, 10), cost_usd: round6(spent), run_id: ctx.runId, checked_at: at,
    }, 'resolution=merge-duplicates,return=minimal')
    await rest('PATCH', itemPath, { status: 'done', attempts, error: null, cost_usd: round6(spent), updated_at: at })
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000)
    await rest('PATCH', itemPath, { attempts, error: message, cost_usd: round6(spent), updated_at: at, ...(attempts >= MAX_CHECK_ATTEMPTS ? { status: 'error' } : {}) })
      .catch((e) => console.error(`[${FN}] item ${it.company_key} save failed:`, e))
  }
  return spent
}

// ---------------------------------------------------------------------------
// the chain

async function selfInvoke(runId: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${FN}`, {
        method: 'POST',
        headers: { ...REST_HEADERS },
        body: JSON.stringify({ action: 'continue', run_id: runId, prev: token }),
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

const runPath = (id: string) => `company_check_runs?id=eq.${id}`
const fmt = (n: number) => `$${n.toFixed(2)}`

export interface Summary {
  items?: Record<string, number>
  companies_by_fit?: Record<string, number>
  leads_by_fit?: Record<string, number>
  companies_by_type?: Record<string, number>
  leads_by_type?: Record<string, number>
}

const TYPE_ORDER = ['residential', 'mixed', 'multifamily', 'commercial', 'other', 'unknown']

/** The feed / Telegram message when a run ends: spend, verdicts and property types (companies and their leads). */
export function finishText(status: 'done' | 'capped', s: Summary, o: { spent: number; cap: number; estimate: number | null; scope: string }): string {
  const est = o.estimate === null ? '' : ` (estimate ${fmt(o.estimate)})`
  const scope = o.scope === 'sending' ? ' of the still-sending leads' : ''
  const fit = s.companies_by_fit ?? {}
  const leads = s.leads_by_fit ?? {}
  const ct = s.companies_by_type ?? {}
  const lt = s.leads_by_type ?? {}
  const types = TYPE_ORDER.filter((t) => ct[t]).map((t) => `${t} ${ct[t]} (${lt[t] ?? 0} leads)`).join(', ')
  const typeLine = types ? `\nBy property type: ${types}.` : ''
  return status === 'done'
    ? `Company check${scope} finished: ${fmt(o.spent)} spent${est}.\nFit ${fit.fit ?? 0} companies (${leads.fit ?? 0} leads), not fit ${fit.not_fit ?? 0} (${leads.not_fit ?? 0} leads), unclear ${fit.unclear ?? 0}; ${s.items?.error ?? 0} failed.${typeLine}`
    : `Company check${scope} stopped at its ${fmt(o.cap)} cap (${fmt(o.spent)} spent${est}) with ${s.items?.pending ?? 0} companies still unchecked. Ask Lume to check the rest.${typeLine}`
}

/** Claim the run's lease, check companies until done / capped / out of time, then hand off. */
export async function runChecks(runId: string, prev: string | null, deps: Deps = {}): Promise<void> {
  const now = deps.now ?? Date.now
  const token = crypto.randomUUID()
  const free = `or=(lease_until.is.null,lease_until.lt.${enc(iso(now()))}${prev && UUID_RE.test(prev) ? `,lease_token.eq.${prev}` : ''})`
  const claimed = (await rest('PATCH', `${runPath(runId)}&status=eq.running&${free}`, { lease_token: token, lease_until: iso(now() + LEASE_MS) }, rep)) as Record<string, unknown>[] | null
  const run = claimed?.[0]
  if (!run) return // someone else holds it, or it is no longer running
  const ctx: Ctx = { runId, icp: String(run.icp_description), icpKey: String(run.icp_key), token, startedAt: now(), now, sleep: deps.sleep ?? defaultSleep }
  const cap = num(run.max_usd)
  let spent = num(run.spent_usd)
  const mine = `${runPath(runId)}&lease_token=eq.${token}`
  const finish = async (status: 'done' | 'capped') => {
    await rest('PATCH', mine, { status, spent_usd: round6(spent), lease_token: null, lease_until: null, updated_at: iso(now()), finished_at: iso(now()) }, rep)
    const s = ((await rpc('company_check_summary', { p_run_id: runId }).catch(() => null)) ?? {}) as Summary
    const estimate = run.estimate_usd === null || run.estimate_usd === undefined ? null : num(run.estimate_usd)
    await notify(runId, `company_check_${status}`, finishText(status, s, { spent, cap, estimate, scope: String(run.scope ?? 'all') }))
  }

  while (WALL_CLOCK_MS - (now() - ctx.startedAt) >= MIN_LEFT_FOR_PAIR_MS) {
    const rows = (await rest('GET', `company_check_items?run_id=eq.${runId}&status=eq.pending&attempts=lt.${MAX_CHECK_ATTEMPTS}&order=leads.desc,company_key.asc&limit=${VERIFY_WORKERS}&select=company_key,company_name,website,attempts`)) as Item[] | null
    if (!rows?.length) return finish('done')
    const affordable = Math.floor((cap - spent + 1e-9) / CHECK_USD_PER_COMPANY)
    if (affordable <= 0) return finish('capped')
    const costs = await Promise.all(rows.slice(0, affordable).map((it) => checkOne(ctx, it)))
    spent += costs.reduce((a, b) => a + b, 0)
    const still = (await rest('PATCH', `${mine}&status=eq.running`, { spent_usd: round6(spent), lease_until: iso(now() + LEASE_MS), updated_at: iso(now()) }, rep)) as unknown[] | null
    if (!still?.length) return // lease lost or the run was stopped: touch nothing else
  }
  const handed = await (deps.handOff ?? selfInvoke)(runId, token)
  if (!handed) await rest('PATCH', mine, { lease_until: iso(now() - 1000) }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// actions

type Run = { id: string; status: string; spent_usd: number | string; action_id: string | null }

async function start(body: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void, deps: Deps): Promise<Response> {
  const jobId = String(body.job_id ?? '').toLowerCase()
  const actionId = String(body.action_id ?? '').toLowerCase()
  const maxUsd = Number(body.max_usd)
  if (!UUID_RE.test(jobId) || !UUID_RE.test(actionId) || !(maxUsd > 0) || maxUsd > MAX_APPROVAL_USD) return reply({ error: 'bad_start' }, 400)
  if (!PERPLEXITY_API_KEY) return reply({ error: 'perplexity_not_configured' }, 503)
  if (!ANTHROPIC_API_KEY) return reply({ error: 'anthropic_not_configured' }, 503)
  // Defence in depth: only an owner-approved company_check for this very job may start it; its ICP is the one approved.
  const actions = (await rest('GET', `pending_actions?id=eq.${actionId}&select=kind,status,payload`)) as { kind: string; status: string; payload: Record<string, unknown> | null }[] | null
  const action = actions?.[0]
  const icp = typeof action?.payload?.icp === 'string' ? action.payload.icp.trim() : ''
  if (!action || action.kind !== 'company_check' || !['approved', 'executing'].includes(action.status) || action.payload?.job_id !== jobId || !icp) {
    return reply({ error: 'action_not_approved' }, 403)
  }
  // The approved scope (an action filed before scopes existed carries none: 'all').
  const scope = action.payload?.scope ?? 'all'
  if (typeof scope !== 'string' || !SCOPES.has(scope)) return reply({ error: 'bad_scope' }, 400)
  const run = (await rpc('company_check_open_run', { p_job_id: jobId, p_icp: icp, p_scope: scope })) as Run | null
  if (!run?.id) return reply({ error: 'run_not_opened' }, 500)
  if (run.action_id === actionId) {
    return run.status === 'running' ? reply({ ok: true, run_id: run.id, already: true }, 202) : reply({ error: 'action_already_used', status: run.status }, 409)
  }
  if (run.status === 'running') return reply({ error: 'run_in_progress', run_id: run.id }, 409)
  const summary = await rpc('company_check_seed', { p_run_id: run.id }) as { items?: Record<string, number> } | null
  const cap = round6(num(run.spent_usd) + maxUsd)
  const estimate = typeof action.payload?.estimate_usd === 'number' ? action.payload.estimate_usd : null
  const flipped = (await rest('PATCH', `${runPath(run.id)}&status=eq.${run.status}`, {
    status: 'running', max_usd: cap, action_id: actionId, estimate_usd: estimate, lease_token: null, lease_until: null, error: null, finished_at: null, updated_at: new Date().toISOString(),
  }, rep)) as unknown[] | null
  if (!flipped?.length) return reply({ error: 'conflict' }, 409)
  const go = deps.run ?? ((id: string, prev: string | null) => runChecks(id, prev, deps))
  waitUntil(go(run.id, null))
  return reply({ ok: true, run_id: run.id, max_usd: cap, items: summary?.items ?? {} }, 202)
}

async function sweep(waitUntil: (p: Promise<unknown>) => void, deps: Deps): Promise<Response> {
  const rows = (await rest('GET', `company_check_runs?status=eq.running&or=(lease_until.is.null,lease_until.lt.${enc(new Date().toISOString())})&select=id&limit=5`)) as { id: string }[] | null
  const go = deps.run ?? ((id: string, prev: string | null) => runChecks(id, prev, deps))
  for (const r of rows ?? []) waitUntil(go(r.id, null))
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
        if (!UUID_RE.test(String(body.run_id)) || !UUID_RE.test(String(body.prev))) return reply({ error: 'bad_continue' }, 400)
        const go = deps.run ?? ((id: string, prev: string | null) => runChecks(id, prev, deps))
        waitUntil(go(String(body.run_id), String(body.prev)))
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
