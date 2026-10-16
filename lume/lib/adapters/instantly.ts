import 'server-only'
import {
  itemsOf,
  mapAccounts,
  mapAnalyticsOverview,
  mapCampaigns,
  mapDaily,
  type AnalyticsOverview,
  type DailyPoint,
  type InstantlyAccount,
  type InstantlyCampaign,
} from '@/lib/adapters/instantly.map'

/**
 * Instantly API v2, read side. Ported from the root app's `lib/instantly.ts`
 * (analytics overview + daily) and `app/api/instantly/campaigns/route.ts`
 * (paged list, deleted campaigns dropped), plus `GET /accounts`.
 *
 * Server-only: the key never reaches the browser. Successful responses are
 * cached in memory for 60 s per URL (one warm lambda / dev server serves the
 * Overview's poll from cache); failures are never cached.
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

const cache = new Map<string, { at: number; body: unknown }>()

/** Test hook. */
export function clearInstantlyCache(): void {
  cache.clear()
}

async function instantlyGet(path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
  const key = process.env.INSTANTLY_API_KEY?.trim()
  if (!key) throw new InstantlyError(0, 'INSTANTLY_API_KEY is not configured')

  const url = new URL(`${INSTANTLY_BASE_URL}${path}`)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v)
  const href = url.toString()

  const hit = cache.get(href)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body

  const res = await fetch(href, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new InstantlyError(res.status, `Instantly ${path} failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const body: unknown = await res.json()
  cache.set(href, { at: Date.now(), body })
  return body
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
