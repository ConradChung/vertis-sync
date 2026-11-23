import 'server-only'

/**
 * Client for the Railway crawl worker (workers/crawl): "is this website a
 * property manager or a vendor?". Read-only and cheap (~$0.0002/site), but
 * callers that classify more than a handful of sites still go through their
 * own pending-action gate.
 *
 * Env: CRAWL_WORKER_URL, CRAWL_WORKER_SECRET (sent as X-Worker-Secret).
 *
 * Time: one budget for the whole call (default 240 s, under Vercel's 300 s
 * maxDuration). Batches of 20 run one after another. Each batch gives the worker
 * a deadline = min(200 s, what's left − 30 s for a Railway wake-up and the
 * network). The worker returns every site that finished by then and marks the
 * rest timed_out. When too little budget is left to give a batch a useful
 * deadline, no more batches start. Callers requeue `timedOut` + `notSent`.
 *
 * Retry: once, after 5 s, only for a cold start (502/503/504 or connection
 * refused), and only if the budget still allows a batch. Never after a
 * timeout: a second wait wouldn't fit.
 */

export const CRAWL_BATCH_MAX = 20
export const CRAWL_CALL_BUDGET_MS = 240_000
export const WORKER_DEADLINE_MAX_S = 200
/** Railway wake-up + network, spent before the worker's own deadline clock starts. */
export const COLD_START_MARGIN_MS = 30_000
/** Below this, a batch can't do useful work; stop and hand back the rest. */
export const MIN_WORKER_DEADLINE_S = 20
export const RETRY_DELAY_MS = 5_000

export type CrawlVerdict = 'property_manager' | 'not_property_manager' | 'unreachable' | 'error'

export interface CrawlResult {
  domain: string
  verdict: CrawlVerdict
  confidence: 'high' | 'medium' | 'low' | null
  reason: string
  linkedin_url: string | null
  doors_hint: string | null
  property_type: string | null
}

export type CrawlError = 'not_configured' | 'unauthorized' | 'timeout' | 'unreachable' | `http_${number}` | 'bad_response'

export interface CrawlOutcome {
  ok: boolean
  error?: CrawlError
  /** Sites the worker finished (any verdict but timed_out). */
  results: CrawlResult[]
  /** Sent, but the worker's deadline hit first. Requeue. */
  timedOut: string[]
  /** Never sent (budget ran out, or an earlier batch failed). Requeue. */
  notSent: string[]
}

export interface ClassifyOptions {
  rules?: string
  budgetMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const VERDICTS = new Set<CrawlVerdict>(['property_manager', 'not_property_manager', 'unreachable', 'error'])

function toResult(raw: Record<string, unknown>): CrawlResult | null {
  if (typeof raw.domain !== 'string' || !VERDICTS.has(raw.verdict as CrawlVerdict)) return null
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const conf = raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low' ? raw.confidence : null
  return {
    domain: raw.domain,
    verdict: raw.verdict as CrawlVerdict,
    confidence: conf,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    linkedin_url: str(raw.linkedin_url),
    doors_hint: str(raw.doors_hint),
    property_type: str(raw.property_type),
  }
}

type BatchResponse = { kind: 'ok'; rows: unknown[] } | { kind: 'cold' } | { kind: 'fail'; error: CrawlError }

async function postBatch(base: string, secret: string, batch: string[], rules: string | undefined, deadlineS: number, timeoutMs: number): Promise<BatchResponse> {
  let res: Response
  try {
    res = await fetch(`${base}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': secret },
      body: JSON.stringify({ domains: batch, deadline_s: deadlineS, ...(rules ? { rules } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return { kind: 'fail', error: 'timeout' }
    console.error('[crawl-worker]', err instanceof Error ? err.message : err)
    return { kind: 'cold' }
  }
  if (res.status === 401) return { kind: 'fail', error: 'unauthorized' }
  if (res.status === 502 || res.status === 503 || res.status === 504) return { kind: 'cold' }
  if (!res.ok) {
    console.error(`[crawl-worker] HTTP ${res.status}`)
    return { kind: 'fail', error: `http_${res.status}` }
  }
  const json = (await res.json().catch(() => null)) as { ok?: unknown; results?: unknown } | null
  if (!json || json.ok !== true || !Array.isArray(json.results)) return { kind: 'fail', error: 'bad_response' }
  return { kind: 'ok', rows: json.results }
}

/** Classify domains within one time budget. Always returns what finished, plus what to requeue. */
export async function classifyDomains(domains: string[], opts: ClassifyOptions = {}): Promise<CrawlOutcome> {
  const out: CrawlOutcome = { ok: true, results: [], timedOut: [], notSent: [] }
  const base = process.env.CRAWL_WORKER_URL?.replace(/\/+$/, '')
  const secret = process.env.CRAWL_WORKER_SECRET
  if (!base || !secret) return { ...out, ok: false, error: 'not_configured', notSent: [...domains] }

  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + (opts.budgetMs ?? CRAWL_CALL_BUDGET_MS)
  const workerDeadlineS = () => Math.min(WORKER_DEADLINE_MAX_S, Math.floor((deadline - now() - COLD_START_MARGIN_MS) / 1000))

  for (let i = 0; i < domains.length; i += CRAWL_BATCH_MAX) {
    const batch = domains.slice(i, i + CRAWL_BATCH_MAX)
    const stop = (error?: CrawlError) => {
      out.notSent.push(...domains.slice(i))
      if (error) Object.assign(out, { ok: false, error })
      return out
    }

    let resp: BatchResponse | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const dl = workerDeadlineS()
      if (dl < MIN_WORKER_DEADLINE_S) return stop(resp?.kind === 'cold' ? 'unreachable' : undefined)
      resp = await postBatch(base, secret, batch, opts.rules, dl, deadline - now())
      if (resp.kind !== 'cold') break
      if (attempt === 0) await sleep(RETRY_DELAY_MS)
    }
    if (!resp || resp.kind === 'cold') return stop('unreachable')
    if (resp.kind === 'fail') return stop(resp.error)

    for (const raw of resp.rows) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      if (r.verdict === 'timed_out' && typeof r.domain === 'string') out.timedOut.push(r.domain)
      else {
        const row = toResult(r)
        if (row) out.results.push(row)
      }
    }
  }
  return out
}
