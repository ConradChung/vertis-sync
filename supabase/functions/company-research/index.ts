// Supabase Edge Function: company-research (research P2,
// docs/lume/2026-10-29-research-signals-design.md).
//
// POST { domain } | { url }   start research on one company
// POST { crawl_id }           internal: continue polling a running crawl
//
// Caller: service role only. The bearer must equal SUPABASE_SERVICE_ROLE_KEY
// (constant-time compare). The gateway's JWT check alone would also admit the
// anon key, and this function spends money.
//
// Start:
//   1. normalize the domain, upsert `companies`
//   2. budget gate BEFORE any spend. The cap (LUME_RESEARCH_APIFY_CAP_USD,
//      default 29) is the Apify plan's account-wide monthly cap.
//      lume_research_reserve_crawl() computes committed = Apify account usage
//      (includes our finished runs, but lags) + reservations: estimates of our
//      crawls still pending/running, plus the actual cost of crawls finished in
//      the last 10 minutes; when account usage is unreadable we send null and it
//      falls back to our own month-to-date sum (finished + reserved), never $0.
//      Refused with budget_exceeded when committed + this run's estimate > cap;
//      otherwise it inserts the pending crawl carrying the estimate.
//   3. start apify/website-content-crawler (cheerio, <= 8 pages, 1 GB, 180 s)
//   4. answer 202; polling continues in the background
// Continue (self-reinvoked before the 150 s wall clock, like operating-city-enricher;
// the clock starts at the request, see WALL_CLOCK_MS):
//   poll the run; when it ends, claim the crawl once, snapshot pages, record
//   the run's actual usageTotalUsd, detect the PMS (deterministic), extract
//   door_count / after_hours / city / region / country with Haiku, keep only
//   verified values, write company_facts (each with source URL + snippet).

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }
import { alert, gateKey } from '../_shared/alert.ts'
import { secretsMatch } from '../_shared/lume/action.ts'
import {
  buildCrawlInput,
  CRAWL_ACTOR_ID,
  CRAWL_MEMORY_MB,
  CRAWL_TIMEOUT_SECS,
  crawlEstimateUsd,
  normalizeTarget,
  pagesFromItems,
  parseCap,
  parseMonthlyUsage,
} from '../_shared/research/crawl.ts'
import { buildExtractionRequest, EXTRACT_MODEL, parseExtractionResponse } from '../_shared/research/extract.ts'
import { detectPms, type Page, type PmsResult } from '../_shared/research/pms.ts'
import { type Dropped, verifyCandidates } from '../_shared/research/verify.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_API_TOKEN = Deno.env.get('APIFY_API_TOKEN') ?? ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

const APIFY = 'https://api.apify.com/v2'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const FN = 'company-research'

/** Crawls pending/running longer than this are failed on every invocation (the run itself times out at 180 s). */
export const STALE_MINUTES = 15
/**
 * Time budget per invocation, measured from the REQUEST start (start() can
 * already have spent ~40 s on the usage read, the gate and the run start).
 * Edge wall clock assumed 150 s.
 *   extraction cutoff = 150 - (dataset read 20 + Haiku 60 + writes 10 + margin 10) = 50 s:
 *     a run that finishes later than that is extracted by a fresh invocation.
 *   poll cutoff = 150 - (run read 20 + hand-off 10 + poll sleep 5 + margin 10) = 105 s.
 */
export const WALL_CLOCK_MS = 150_000
const DATASET_READ_MS = 20_000
const HAIKU_MS = 60_000
const WRITES_MS = 10_000
const MARGIN_MS = 10_000
const RUN_READ_MS = 20_000
const HANDOFF_MS = 10_000
const POLL_MS = 5_000
export const EXTRACT_CUTOFF_MS = WALL_CLOCK_MS - (DATASET_READ_MS + HAIKU_MS + WRITES_MS + MARGIN_MS)
export const POLL_CUTOFF_MS = WALL_CLOCK_MS - (RUN_READ_MS + HANDOFF_MS + POLL_MS + MARGIN_MS)
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNAPSHOT_TEXT_CHARS = 20_000

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
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : null
}

function apify(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${APIFY}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${APIFY_API_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  })
}

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

function notifyFailure(crawlId: string, domainOrUrl: string, reason: string): Promise<unknown> {
  return alert({
    source: FN,
    severity: 'warn',
    title: `Company research failed: ${domainOrUrl}`.slice(0, 120),
    body: reason.slice(0, 1000),
    dedupe_key: gateKey(crawlId, 'research_failed'),
  }).catch(() => undefined)
}

/** Apify account usage this cycle, or null when it can't be read (the gate then uses our ledger). */
async function apifyMonthlyUsage(): Promise<number | null> {
  try {
    const res = await apify('/users/me/usage/monthly')
    if (!res.ok) {
      console.warn(`[${FN}] Apify monthly usage unreadable (${res.status}); gating on the ledger alone`)
      await res.body?.cancel()
      return null
    }
    return parseMonthlyUsage(await res.json())
  } catch (err) {
    console.warn(`[${FN}] Apify monthly usage unreadable:`, err)
    return null
  }
}

export interface ContinueDeps {
  /** When this invocation's request started (the wall clock's zero). */
  startedAt?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

async function handOff(crawlId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${FN}`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ crawl_id: crawlId }),
        // The callee answers 202 at once; a hung invoke must not eat this invocation's wall clock.
        signal: AbortSignal.timeout(HANDOFF_MS),
      })
      await res.body?.cancel()
      if (res.ok) return true
      console.error(`[${FN}] hand-off attempt ${attempt + 1}: HTTP ${res.status}`)
    } catch (err) {
      console.error(`[${FN}] hand-off attempt ${attempt + 1} threw:`, err)
    }
    await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)))
  }
  return false
}

/**
 * Fail crawls stuck pending/running for > STALE_MINUTES (a dead hand-off chain
 * would otherwise block the company and keep its reservation forever). Runs on
 * every invocation, like Lume's failStaleRuns; never blocks the request.
 */
async function sweepStale(): Promise<void> {
  try {
    const n = await rest('POST', 'rpc/lume_research_fail_stale_crawls', { p_minutes: STALE_MINUTES }, 'return=representation')
    if (typeof n === 'number' && n > 0) console.log(`[${FN}] failed ${n} stale crawl(s)`)
  } catch (err) {
    console.error(`[${FN}] stale sweep failed:`, err)
  }
}

// ---------------------------------------------------------------------------
// start

async function start(target: { domain: string; startUrl: string }, waitUntil: (p: Promise<unknown>) => void, deps: ContinueDeps): Promise<Response> {
  if (!APIFY_API_TOKEN) return reply({ error: 'apify_not_configured' }, 503)
  if (!ANTHROPIC_API_KEY) return reply({ error: 'anthropic_not_configured' }, 503)

  const companies = (await rest('POST', 'companies?on_conflict=domain', { domain: target.domain, website: target.startUrl },
    'resolution=merge-duplicates,return=representation')) as { id: string }[]
  const companyId = companies?.[0]?.id
  if (!companyId) throw new Error('company upsert returned no row')

  const cap = parseCap(Deno.env.get('LUME_RESEARCH_APIFY_CAP_USD'))
  const estimate = crawlEstimateUsd()
  const account = await apifyMonthlyUsage()
  const gate = (await rest('POST', 'rpc/lume_research_reserve_crawl', {
    p_company: companyId, p_start_url: target.startUrl, p_estimate: estimate, p_external_usd: account, p_cap: cap,
  }, 'return=representation')) as Record<string, unknown>
  if (!gate || gate.ok !== true) {
    const error = typeof gate?.error === 'string' ? gate.error : 'reserve_failed'
    console.log(`[${FN}] ${target.domain}: refused (${error})`)
    return reply({ ...gate, ok: false, error, company_id: companyId, domain: target.domain }, 409)
  }
  const crawlId = String(gate.crawl_id)

  // Spend starts here.
  let runId: string
  try {
    const res = await apify(`/acts/${CRAWL_ACTOR_ID}/runs?timeout=${CRAWL_TIMEOUT_SECS}&memory=${CRAWL_MEMORY_MB}`, {
      method: 'POST',
      body: JSON.stringify(buildCrawlInput(target.startUrl, target.domain)),
    })
    const body = await res.json().catch(() => null) as { data?: { id?: string }; error?: { message?: string } } | null
    if (!res.ok || !body?.data?.id) throw new Error(`Apify start failed (${res.status}): ${body?.error?.message ?? 'no run id'}`)
    runId = body.data.id
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await rest('PATCH', `company_crawls?id=eq.${crawlId}`, {
      status: 'failed', cost_usd: 0, error: message.slice(0, 2000), finished_at: new Date().toISOString(),
    })
    await notifyFailure(crawlId, target.domain, message)
    return reply({ ok: false, error: 'apify_start_failed', detail: message.slice(0, 300), crawl_id: crawlId }, 502)
  }

  await rest('PATCH', `company_crawls?id=eq.${crawlId}`, {
    status: 'running', apify_run_id: runId, actor_id: CRAWL_ACTOR_ID, started_at: new Date().toISOString(),
  })
  waitUntil(runContinue(crawlId, deps))
  return reply({
    ok: true, crawl_id: crawlId, company_id: companyId, domain: target.domain,
    estimate_usd: estimate, basis: gate.basis, account_usd: gate.account_usd, reserved_usd: gate.reserved_usd,
    committed_usd: gate.committed_usd, cap_usd: gate.cap_usd,
  }, 202)
}

// ---------------------------------------------------------------------------
// continue

interface CrawlRow {
  id: string
  company_id: string
  status: string
  apify_run_id: string | null
  estimate_usd: number | string
  start_url: string
  extraction: unknown
}

interface RunData {
  status?: string
  statusMessage?: string
  defaultDatasetId?: string
  usageTotalUsd?: number
}

function runContinue(crawlId: string, deps: ContinueDeps): Promise<void> {
  return continueCrawl(crawlId, deps).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${FN}] crawl ${crawlId} failed:`, message)
    try {
      // Cost stays at the reserved estimate: the conservative figure when the actual is unknown.
      await rest('PATCH', `company_crawls?id=eq.${crawlId}&status=eq.running`, {
        status: 'failed', error: message.slice(0, 2000), finished_at: new Date().toISOString(),
      })
    } catch (patchErr) {
      console.error(`[${FN}] could not mark crawl ${crawlId} failed:`, patchErr)
    }
    await notifyFailure(crawlId, crawlId, message)
  })
}

export async function continueCrawl(crawlId: string, deps: ContinueDeps = {}): Promise<void> {
  const clock = deps.now ?? Date.now
  const startedAt = deps.startedAt ?? clock()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const rows = (await rest('GET',
    `company_crawls?id=eq.${crawlId}&select=id,company_id,status,apify_run_id,estimate_usd,start_url,extraction`)) as CrawlRow[]
  const crawl = rows?.[0]
  if (!crawl || crawl.status !== 'running' || crawl.extraction !== null || !crawl.apify_run_id) {
    console.log(`[${FN}] crawl ${crawlId} is not running — nothing to do`)
    return
  }

  let run: RunData
  while (true) {
    const res = await apify(`/actor-runs/${encodeURIComponent(crawl.apify_run_id)}`)
    if (!res.ok) throw new Error(`Apify run read failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
    run = ((await res.json()) as { data?: RunData }).data ?? {}
    const elapsed = clock() - startedAt
    const done = TERMINAL.has(run.status ?? '')
    if ((done && elapsed > EXTRACT_CUTOFF_MS) || (!done && elapsed > POLL_CUTOFF_MS)) {
      if (!(await handOff(crawlId))) {
        await notifyFailure(crawlId, crawl.start_url, 'Could not start the next polling chunk after 4 attempts; the crawl is still running.')
      }
      return
    }
    if (done) break
    await sleep(POLL_MS)
  }

  // Claim the finish once: a duplicate hand-off must not write facts twice.
  const claimed = (await rest('PATCH', `company_crawls?id=eq.${crawlId}&status=eq.running&extraction=is.null`,
    { extraction: { stage: 'finishing' } }, 'return=representation')) as unknown[]
  if (!claimed || claimed.length === 0) return

  const cost = num(run.usageTotalUsd) ?? Number(crawl.estimate_usd)
  const now = () => new Date().toISOString()
  const status = run.status ?? 'UNKNOWN'

  if (status !== 'SUCCEEDED' && status !== 'TIMED-OUT') {
    const error = `Apify run ${status}${run.statusMessage ? `: ${run.statusMessage}` : ''}`
    await rest('PATCH', `company_crawls?id=eq.${crawlId}`, {
      status: 'failed', cost_usd: cost, error: error.slice(0, 2000), extraction: { run_status: status }, finished_at: now(),
    })
    await notifyFailure(crawlId, crawl.start_url, error)
    return
  }

  const itemsRes = await apify(`/datasets/${encodeURIComponent(run.defaultDatasetId ?? '')}/items?clean=true&format=json&limit=20`)
  if (!itemsRes.ok) throw new Error(`Apify dataset read failed (${itemsRes.status})`)
  const items = await itemsRes.json() as unknown[]
  const pages = pagesFromItems(Array.isArray(items) ? items : [])
  const snapshot = pages.map((p) => ({ url: p.url, text: p.text.slice(0, SNAPSHOT_TEXT_CHARS), links: p.links }))

  if (!pages.length) {
    const error = `no pages crawled (run ${status})`
    await rest('PATCH', `company_crawls?id=eq.${crawlId}`, {
      status: 'failed', cost_usd: cost, pages: [], page_count: 0, error, extraction: { run_status: status }, finished_at: now(),
    })
    await notifyFailure(crawlId, crawl.start_url, error)
    return
  }

  const pms = detectPms(pages)
  let extractionError: string | null = null
  let kept: ReturnType<typeof verifyCandidates>['kept'] = []
  let dropped: Dropped[] = []
  let usage: unknown = null
  try {
    const r = await extract(crawl.start_url, pages)
    ;({ kept, dropped } = verifyCandidates(r.candidates, pages))
    usage = r.usage
    for (const d of dropped) console.log(`[${FN}] crawl ${crawlId}: dropped ${d.field} (${d.reason}) from ${d.source_url ?? '-'}`)
  } catch (err) {
    extractionError = `extraction_failed: ${err instanceof Error ? err.message : String(err)}`
  }

  const facts = factRows(crawl.company_id, crawlId, pms, kept)
  if (facts.length) await rest('POST', 'company_facts', facts)

  await rest('PATCH', `company_crawls?id=eq.${crawlId}`, {
    status: extractionError ? 'failed' : 'succeeded',
    cost_usd: cost,
    pages: snapshot,
    page_count: pages.length,
    error: extractionError?.slice(0, 2000) ?? null,
    extraction: { run_status: status, model: EXTRACT_MODEL, pms, kept: kept.length, dropped, usage },
    finished_at: now(),
  })
  await rest('PATCH', `companies?id=eq.${crawl.company_id}`, { last_crawled_at: now(), updated_at: now() })
  if (extractionError) await notifyFailure(crawlId, crawl.start_url, extractionError)
}

async function extract(startUrl: string, pages: Page[]) {
  const domain = new URL(startUrl).hostname.replace(/^www\./, '')
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(buildExtractionRequest(domain, pages)),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return parseExtractionResponse(await res.json())
}

function factRows(companyId: string, crawlId: string, pms: PmsResult, kept: ReturnType<typeof verifyCandidates>['kept']) {
  const rows: Record<string, unknown>[] = []
  // Unknown has no evidence and so no source URL: not written.
  if (pms.value !== 'unknown' && pms.source_url && pms.snippet) {
    rows.push({
      company_id: companyId, crawl_id: crawlId, field: 'pms', value: pms.value, copy_value: null,
      confidence: pms.confidence, source_url: pms.source_url, snippet: pms.snippet.slice(0, 1000),
    })
  }
  for (const k of kept) {
    rows.push({
      company_id: companyId, crawl_id: crawlId, field: k.field, value: k.value, copy_value: k.copy_value,
      confidence: k.confidence, source_url: k.source_url, snippet: k.snippet,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// entry

export async function handle(
  req: Request,
  waitUntil: (p: Promise<unknown>) => void = (p) => EdgeRuntime.waitUntil(p),
  deps: ContinueDeps = {},
): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  // The wall clock runs from here, through start() and into the background poll.
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

  if (body.crawl_id !== undefined) {
    if (typeof body.crawl_id !== 'string' || !UUID_RE.test(body.crawl_id)) return reply({ error: 'bad_crawl_id' }, 400)
    await sweepStale()
    waitUntil(runContinue(body.crawl_id, deps))
    return reply({ ok: true, crawl_id: body.crawl_id }, 202)
  }

  const target = normalizeTarget({ domain: body.domain, url: body.url })
  if ('error' in target) return reply({ error: target.error }, 400)
  await sweepStale()
  try {
    return await start(target, waitUntil, deps)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${FN}] start failed for ${target.domain}:`, message)
    return reply({ ok: false, error: 'internal_error', detail: message.slice(0, 300) }, 500)
  }
}

Deno.serve((req) => handle(req))
