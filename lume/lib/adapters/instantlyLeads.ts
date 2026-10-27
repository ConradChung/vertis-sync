import 'server-only'
import { INSTANTLY_BASE_URL, InstantlyError } from '@/lib/adapters/instantly'
import {
  leadMatches,
  mapLead,
  mapUsage,
  summarizeLeads,
  upstreamFilter,
  type CampaignLead,
  type ContactUsage,
  type LeadQuery,
  type LeadSummary,
} from '@/lib/adapters/instantlyLeads.map'

/**
 * Instantly API v2, lead reads: `POST /leads/list` (a read despite the verb),
 * `GET /campaigns/analytics` (lead count) and `GET
 * /workspace-billing/plan-details` (uploaded contacts vs the plan limit).
 * Uncached: removal and cap decisions need fresh numbers. Deleting leads is
 * in `instantlyWrite.ts` (executor only).
 *
 * Rate limits are workspace-wide (100 rps, 6,000 / min): calls run one page
 * at a time, and a 429 waits for `Retry-After` (at most 5 s) and retries up
 * to twice before failing with the usual `InstantlyError`.
 */

const PAGE_SIZE = 100
export const MAX_LIST = 1000
const DEFAULT_SCAN_PAGES = 20
export const MAX_SCAN_PAGES = 50
const MAX_RETRIES = 2
const MAX_WAIT_MS = 5_000

/** Swappable in tests. */
export const timing = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }

function waitMs(header: string | null): number {
  const secs = Number(header)
  if (header && Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), MAX_WAIT_MS)
  return 1_000
}

/** One Instantly call with the bearer, 429 retries and the adapter's error style. */
export async function instantlyCall(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  const key = process.env.INSTANTLY_API_KEY?.trim()
  if (!key) throw new InstantlyError(0, 'INSTANTLY_API_KEY is not configured')
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(`${INSTANTLY_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new InstantlyError(0, `Instantly ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await timing.sleep(waitMs(res.headers.get('retry-after')))
      continue
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) throw new InstantlyError(res.status, `Instantly ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`)
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      return {}
    }
  }
}

interface Page {
  items: unknown[]
  next: string | null
}

function pageOf(body: unknown): Page {
  const b = (body ?? {}) as { items?: unknown; next_starting_after?: unknown }
  return {
    items: Array.isArray(b.items) ? b.items : [],
    next: typeof b.next_starting_after === 'string' && b.next_starting_after ? b.next_starting_after : null,
  }
}

export interface LeadListResult {
  leads: CampaignLead[]
  /** Leads matching the state (all of them, not just the ones returned). */
  matched: number
  /** Leads Instantly returned before the client-side checks. */
  scanned: number
  /** True when the scan stopped at its page cap: there may be more. */
  truncated: boolean
  summary: LeadSummary
}

/**
 * One campaign's leads in a state, newest pages first as Instantly returns
 * them. Scans at most `maxPages` × 100 leads, returns at most `limit`.
 */
export async function listCampaignLeads(
  campaignId: string,
  query: LeadQuery,
  opts: { limit?: number; maxPages?: number; now?: Date } = {}
): Promise<LeadListResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), MAX_LIST)
  const maxPages = Math.min(Math.max(opts.maxPages ?? DEFAULT_SCAN_PAGES, 1), MAX_SCAN_PAGES)
  const now = opts.now ?? new Date()
  const matched: CampaignLead[] = []
  let scanned = 0
  let truncated = false
  let cursor: string | null = null
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      truncated = true
      break
    }
    const body: Record<string, unknown> = { campaign: campaignId, filter: upstreamFilter(query), limit: PAGE_SIZE }
    if (cursor) body.starting_after = cursor
    const { items, next } = pageOf(await instantlyCall('POST', '/leads/list', body))
    scanned += items.length
    for (const raw of items) {
      const l = mapLead(raw)
      if (l && leadMatches(l, query, now)) matched.push(l)
    }
    if (items.length < PAGE_SIZE || !next) break
    cursor = next
  }
  return { leads: matched.slice(0, limit), matched: matched.length, scanned, truncated, summary: summarizeLeads(matched) }
}

export interface FetchedLead {
  lead: CampaignLead
  /** Instantly's full lead object, kept as the removal snapshot. */
  raw: Record<string, unknown>
}

/** The given leads of a campaign as Instantly has them now (missing ids are simply absent). */
export async function getLeadsByIds(campaignId: string, ids: string[]): Promise<FetchedLead[]> {
  const out: FetchedLead[] = []
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += PAGE_SIZE) {
    const chunk = unique.slice(i, i + PAGE_SIZE)
    const { items } = pageOf(await instantlyCall('POST', '/leads/list', { campaign: campaignId, ids: chunk, limit: PAGE_SIZE }))
    for (const raw of items) {
      const lead = mapLead(raw)
      // Defensive: only leads of this campaign, only ids we asked for.
      const r = raw as Record<string, unknown>
      if (lead && chunk.includes(lead.id) && (r.campaign === undefined || r.campaign === null || r.campaign === campaignId)) {
        out.push({ lead, raw: r })
      }
    }
  }
  return out
}

/** Total leads in a campaign (`leads_count` of `GET /campaigns/analytics?id=`), or null when not reported. */
export async function getCampaignLeadCount(campaignId: string): Promise<number | null> {
  const body = await instantlyCall('GET', `/campaigns/analytics?id=${encodeURIComponent(campaignId)}`)
  const row = Array.isArray(body) ? body[0] : body
  const n = (row as { leads_count?: unknown } | null)?.leads_count
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Uploaded contacts vs the outreach plan limit; throws when Instantly does not report them. */
export async function getContactUsage(): Promise<ContactUsage> {
  const usage = mapUsage(await instantlyCall('GET', '/workspace-billing/plan-details'))
  if (!usage) throw new InstantlyError(0, 'Instantly plan details have no outreach lead count / limit')
  return usage
}
