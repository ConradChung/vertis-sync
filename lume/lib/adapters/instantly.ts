import 'server-only'
import {
  itemsOf,
  mapAccounts,
  mapCampaignDetails,
  mapCampaignSequence,
  mapAnalyticsOverview,
  mapCampaigns,
  mapDaily,
  type AnalyticsOverview,
  type DailyPoint,
  type InstantlyAccount,
  type InstantlyCampaign,
  type InstantlyCampaignDetail,
  type SequenceStep,
  mapSteps,
  mapEmail,
  mapThreads,
  type InboxThread,
  type StepPoint,
} from '@/lib/adapters/instantly.map'

/**
 * Instantly API v2, read side. Ported from the root app's `lib/instantly.ts`
 * (analytics overview + daily) and `app/api/instantly/campaigns/route.ts`
 * (paged list, deleted campaigns dropped), plus `GET /accounts`.
 *
 * Server-only: the key never reaches the browser. Responses are cached in
 * memory per URL (see `instantlyGet`), so one warm lambda / dev server serves
 * the Overview's 60 s poll from cache.
 *
 * With `INSTANTLY_API_KEY` unset `isInstantlyConfigured()` is false and the
 * routes answer `{ configured: false }` without calling anything.
 */

export const INSTANTLY_BASE_URL = 'https://api.instantly.ai/api/v2'
const TTL_MS = 60_000
const PAGE_SIZE = 100
const MAX_PAGES = 10

export class InstantlyError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'InstantlyError'
    this.status = status
  }
}

export function isInstantlyConfigured(): boolean {
  return Boolean(process.env.INSTANTLY_API_KEY?.trim())
}

type Entry = { expires: number; body?: unknown; error?: InstantlyError }
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()

const NEGATIVE_TTL_MS = 15_000
const MAX_RETRY_AFTER_MS = 5 * 60_000

/** Test hook. */
export function clearInstantlyCache(): void {
  cache.clear()
  inflight.clear()
}

function store(href: string, entry: Entry): void {
  const now = Date.now()
  for (const [k, e] of cache) if (e.expires <= now) cache.delete(k)
  cache.set(href, entry)
}

/** `Retry-After` (seconds or an HTTP date) → ms, at least the negative TTL. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return NEGATIVE_TTL_MS
  const secs = Number(header)
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now
  if (!Number.isFinite(ms)) return NEGATIVE_TTL_MS
  return Math.min(Math.max(ms, NEGATIVE_TTL_MS), MAX_RETRY_AFTER_MS)
}

/**
 * GET with a per-URL cache: successes for 60 s, failures for 15 s (or the
 * 429's `Retry-After`), and one shared in-flight request per URL so a burst
 * of Overview loads makes one upstream call. Expired entries are pruned on
 * every write.
 */
async function instantlyGet(path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
  const key = process.env.INSTANTLY_API_KEY?.trim()
  if (!key) throw new InstantlyError(0, 'INSTANTLY_API_KEY is not configured')

  const url = new URL(`${INSTANTLY_BASE_URL}${path}`)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v)
  const href = url.toString()

  const hit = cache.get(href)
  if (hit && hit.expires > Date.now()) {
    if (hit.error) throw hit.error
    return hit.body
  }
  const pending = inflight.get(href)
  if (pending) return pending

  const p = (async () => {
    let res: Response
    try {
      res = await fetch(href, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      const e = new InstantlyError(0, `Instantly ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`)
      store(href, { expires: Date.now() + NEGATIVE_TTL_MS, error: e })
      throw e
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const e = new InstantlyError(res.status, `Instantly ${path} failed (${res.status}): ${text.slice(0, 200)}`)
      const ttl = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : NEGATIVE_TTL_MS
      store(href, { expires: Date.now() + ttl, error: e })
      throw e
    }
    const body: unknown = await res.json()
    store(href, { expires: Date.now() + TTL_MS, body })
    return body
  })()
  inflight.set(href, p)
  try {
    return await p
  } finally {
    inflight.delete(href)
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Every page of a cursor-paged list (`limit` + `starting_after`). */
async function getAllPages(path: string, extra: Record<string, string> = {}): Promise<unknown[]> {
  const out: unknown[] = []
  let startingAfter: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await instantlyGet(path, { ...extra, limit: String(PAGE_SIZE), starting_after: startingAfter })
    const items = itemsOf(body)
    out.push(...items)
    const next = (body as { next_starting_after?: unknown } | null)?.next_starting_after
    // The cursor comes back even on a short final page: stop on page size.
    if (items.length < PAGE_SIZE || typeof next !== 'string' || !next) break
    startingAfter = next
  }
  return out
}

export async function listCampaigns(): Promise<InstantlyCampaign[]> {
  return mapCampaigns(await getAllPages('/campaigns'))
}

/** One campaign's totals, or the whole workspace's when `campaignId` is omitted. */
export async function getAnalyticsOverview(campaignId?: string): Promise<AnalyticsOverview> {
  return mapAnalyticsOverview(await instantlyGet('/campaigns/analytics/overview', { id: campaignId }))
}

export async function getDailyAnalytics(opts: { campaignId?: string; startDate?: string; endDate?: string } = {}): Promise<DailyPoint[]> {
  return mapDaily(
    await instantlyGet('/campaigns/analytics/daily', {
      campaign_id: opts.campaignId,
      start_date: opts.startDate,
      end_date: opts.endDate,
    })
  )
}

export async function listAccounts(): Promise<InstantlyAccount[]> {
  return mapAccounts(await getAllPages('/accounts'))
}

/** Every campaign with `daily_limit` and account count, for the `lume_campaigns` sync. */
export async function listCampaignDetails(): Promise<InstantlyCampaignDetail[]> {
  return mapCampaignDetails(await getAllPages('/campaigns'))
}

/** First steps of a campaign's sequence (read-only preview). */
export async function getCampaignSequence(campaignId: string, limit = 3): Promise<SequenceStep[]> {
  return mapCampaignSequence(await instantlyGet(`/campaigns/${encodeURIComponent(campaignId)}`), limit)
}

/** Per-step totals for one campaign (Task 13). Read-only. */
export async function getStepAnalytics(campaignId: string): Promise<StepPoint[]> {
  return mapSteps(await instantlyGet('/campaigns/analytics/steps', { campaign_id: campaignId }))
}

/**
 * One campaign's newest 100 emails grouped into threads (Task 13). Read-only:
 * replying goes through a `send_reply` pending action, never from here.
 */
export async function listCampaignThreads(campaignId: string): Promise<InboxThread[]> {
  return mapThreads(await instantlyGet('/emails', { campaign_id: campaignId, limit: String(PAGE_SIZE) }))
}

/**
 * Who an Instantly email involves: the lead address and its campaign. Used to
 * show the real recipient on a send_reply confirmation. Read-only, cached.
 */
export async function getEmailLead(emailId: string): Promise<{ lead: string | null; campaign_id: string | null }> {
  const body = await instantlyGet(`/emails/${encodeURIComponent(emailId)}`)
  const m = mapEmail(body)
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return {
    lead: m?.lead?.toLowerCase() ?? null,
    campaign_id: typeof raw.campaign_id === 'string' && raw.campaign_id ? raw.campaign_id : null,
  }
}
