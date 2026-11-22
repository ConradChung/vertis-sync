import 'server-only'

/**
 * Client for the Railway crawl worker (workers/crawl): "is this website a
 * property manager or a vendor?". Read-only and cheap (~$0.0002/site), but
 * callers that classify more than a handful of sites still go through their
 * own pending-action gate.
 *
 * Env: CRAWL_WORKER_URL, CRAWL_WORKER_SECRET (sent as X-Worker-Secret).
 * Batches are split at 50 domains (the worker's cap) and sent one at a time.
 */

export const CRAWL_BATCH_MAX = 50
// A cold start (app sleeping) plus 50 sites with subpages can take a few minutes.
export const CRAWL_TIMEOUT_MS = 300_000

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

export type CrawlOutcome =
  | { ok: true; results: CrawlResult[] }
  | { ok: false; error: 'not_configured' | 'unauthorized' | 'timeout' | 'unreachable' | `http_${number}` | 'bad_response'; results: CrawlResult[] }

const VERDICTS = new Set<CrawlVerdict>(['property_manager', 'not_property_manager', 'unreachable', 'error'])

function toResult(raw: unknown): CrawlResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.domain !== 'string' || !VERDICTS.has(r.verdict as CrawlVerdict)) return null
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const conf = r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low' ? r.confidence : null
  return {
    domain: r.domain,
    verdict: r.verdict as CrawlVerdict,
    confidence: conf,
    reason: typeof r.reason === 'string' ? r.reason : '',
    linkedin_url: str(r.linkedin_url),
    doors_hint: str(r.doors_hint),
    property_type: str(r.property_type),
  }
}

/** Classify domains. On a failed batch, returns what earlier batches produced plus the error. */
export async function classifyDomains(domains: string[], rules?: string): Promise<CrawlOutcome> {
  const base = process.env.CRAWL_WORKER_URL?.replace(/\/+$/, '')
  const secret = process.env.CRAWL_WORKER_SECRET
  if (!base || !secret) return { ok: false, error: 'not_configured', results: [] }

  const results: CrawlResult[] = []
  for (let i = 0; i < domains.length; i += CRAWL_BATCH_MAX) {
    const batch = domains.slice(i, i + CRAWL_BATCH_MAX)
    let res: Response
    try {
      res = await fetch(`${base}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': secret },
        body: JSON.stringify(rules ? { domains: batch, rules } : { domains: batch }),
        signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
        cache: 'no-store',
      })
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError'
      console.error('[crawl-worker]', timeout ? 'timeout' : err instanceof Error ? err.message : err)
      return { ok: false, error: timeout ? 'timeout' : 'unreachable', results }
    }
    if (res.status === 401) return { ok: false, error: 'unauthorized', results }
    if (!res.ok) {
      console.error(`[crawl-worker] HTTP ${res.status}`)
      return { ok: false, error: `http_${res.status}`, results }
    }
    const json = (await res.json().catch(() => null)) as { ok?: unknown; results?: unknown } | null
    if (!json || json.ok !== true || !Array.isArray(json.results)) return { ok: false, error: 'bad_response', results }
    for (const raw of json.results) {
      const r = toResult(raw)
      if (r) results.push(r)
    }
  }
  return { ok: true, results }
}
