import 'server-only'
import { INSTANTLY_BASE_URL, InstantlyError } from '@/lib/adapters/instantly'
import { mapInboxEmail, type InboxEmail } from '@/lib/inbox/model'

/**
 * Instantly API v2 `/emails` reads for the inbox manager (Phase 3a):
 * list, one email, one thread. Read-only; sending is `sendReply` in
 * instantlyWrite.ts (executor only).
 *
 * `GET /emails` is limited to 20 requests a minute (workspace-wide), so every
 * call here goes through one budget per server instance:
 *  - at most EMAILS_PER_MINUTE (18, two spare for other instances) upstream
 *    calls in any 60 s window;
 *  - successes are cached per URL (lists 45 s, threads 30 s, one email 5 min)
 *    and one in-flight request per URL is shared;
 *  - past the budget, or while an upstream 429's Retry-After runs, a cached
 *    answer is served marked `stale` (kept up to 10 min), else
 *    `RateLimitedError` with how long to wait (the routes answer 429 +
 *    Retry-After);
 *  - `fresh: true` (the send_reply executor's live-thread re-check) skips the
 *    cache and WAITS for a slot (up to 65 s) rather than failing, so a send
 *    is never decided on stale data.
 */

export const EMAILS_PER_MINUTE = 18
const WINDOW_MS = 60_000
const TTL = { list: 45_000, thread: 30_000, email: 5 * 60_000 } as const
const STALE_MAX_MS = 10 * 60_000
const MAX_FRESH_WAIT_MS = 65_000
const DEFAULT_429_MS = 15_000
const MAX_429_MS = 5 * 60_000
const PAGE = 100
const MAX_THREAD_PAGES = 5

export class RateLimitedError extends InstantlyError {
  readonly retryAfterMs: number
  constructor(retryAfterMs: number) {
    super(429, `Instantly /emails rate limit: retry in ${Math.ceil(retryAfterMs / 1000)} s`)
    this.name = 'RateLimitedError'
    this.retryAfterMs = retryAfterMs
  }
}

/** The shared budget; `now` / `sleep` are swappable in tests. */
export const emailsLimiter = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  stamps: [] as number[],
  blockedUntil: 0,
}

type Entry = { at: number; body: unknown }
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()

/** Test hook. */
export function resetEmailsCache(): void {
  cache.clear()
  inflight.clear()
  emailsLimiter.stamps = []
  emailsLimiter.blockedUntil = 0
}

/** ms until an upstream call may go out (0: now). */
function waitForSlot(): number {
  const now = emailsLimiter.now()
  emailsLimiter.stamps = emailsLimiter.stamps.filter((t) => now - t < WINDOW_MS)
  const blocked = Math.max(0, emailsLimiter.blockedUntil - now)
  const full = emailsLimiter.stamps.length >= EMAILS_PER_MINUTE ? WINDOW_MS - (now - emailsLimiter.stamps[0]) : 0
  return Math.max(blocked, full)
}

function retryAfter(header: string | null): number {
  const secs = Number(header)
  const ms = header && Number.isFinite(secs) ? secs * 1000 : header ? Date.parse(header) - emailsLimiter.now() : NaN
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 1_000), MAX_429_MS) : DEFAULT_429_MS
}

const NOT_FOUND = Symbol('not_found')

async function upstream(href: string, path: string, key: string): Promise<unknown> {
  emailsLimiter.stamps.push(emailsLimiter.now())
  let res: Response
  try {
    res = await fetch(href, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  } catch (err) {
    throw new InstantlyError(0, `Instantly ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 429) {
    const ms = retryAfter(res.headers.get('retry-after'))
    emailsLimiter.blockedUntil = Math.max(emailsLimiter.blockedUntil, emailsLimiter.now() + ms)
    throw new RateLimitedError(ms)
  }
  if (res.status === 404) return NOT_FOUND
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new InstantlyError(res.status, `Instantly GET ${path} failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return res.json()
}

interface Got {
  body: unknown
  stale: boolean
}

async function get(path: string, params: Record<string, string | undefined>, ttl: number, fresh: boolean): Promise<Got> {
  const key = process.env.INSTANTLY_API_KEY?.trim()
  if (!key) throw new InstantlyError(0, 'INSTANTLY_API_KEY is not configured')
  const url = new URL(`${INSTANTLY_BASE_URL}${path}`)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v)
  const href = url.toString()

  const hit = cache.get(href)
  const age = hit ? emailsLimiter.now() - hit.at : Infinity
  if (!fresh && hit && age < ttl) return { body: hit.body, stale: false }
  if (!fresh) {
    const shared = inflight.get(href)
    if (shared) return { body: await shared, stale: false }
  }

  for (let waited = 0; ; ) {
    const wait = waitForSlot()
    if (wait === 0) break
    if (!fresh) {
      if (hit && age < STALE_MAX_MS) return { body: hit.body, stale: true }
      throw new RateLimitedError(wait)
    }
    if (waited + wait > MAX_FRESH_WAIT_MS) throw new RateLimitedError(wait)
    await emailsLimiter.sleep(wait)
    waited += wait
  }

  const p = upstream(href, path, key)
  if (!fresh) inflight.set(href, p)
  try {
    const body = await p
    if (body !== NOT_FOUND) {
      const now = emailsLimiter.now()
      for (const [k, e] of cache) if (now - e.at > STALE_MAX_MS) cache.delete(k)
      cache.set(href, { at: now, body })
    }
    return { body, stale: false }
  } catch (err) {
    if (!fresh && err instanceof RateLimitedError && hit && age < STALE_MAX_MS) return { body: hit.body, stale: true }
    throw err
  } finally {
    if (!fresh) inflight.delete(href)
  }
}

const itemsOf = (body: unknown): unknown[] => {
  const items = (body as { items?: unknown } | null)?.items
  return Array.isArray(items) ? items : []
}
const nextOf = (body: unknown): string | null => {
  const n = (body as { next_starting_after?: unknown } | null)?.next_starting_after
  return typeof n === 'string' && n ? n : null
}
const mapAll = (items: unknown[]): InboxEmail[] => items.map(mapInboxEmail).filter((m): m is InboxEmail => m !== null)

export interface EmailQuery {
  campaign_id?: string
  email_type?: 'received' | 'sent' | 'manual'
  is_unread?: boolean
  i_status?: number
  lead?: string
  limit?: number
  starting_after?: string
}

/** One page of `GET /emails` (newest first), mapped. */
export async function listEmails(q: EmailQuery): Promise<{ emails: InboxEmail[]; next: string | null; stale: boolean }> {
  const got = await get(
    '/emails',
    {
      campaign_id: q.campaign_id,
      email_type: q.email_type,
      is_unread: q.is_unread === undefined ? undefined : String(q.is_unread),
      i_status: q.i_status === undefined ? undefined : String(q.i_status),
      lead: q.lead,
      limit: q.limit === undefined ? undefined : String(Math.min(Math.max(Math.floor(q.limit), 1), PAGE)),
      starting_after: q.starting_after,
    },
    TTL.list,
    false
  )
  return { emails: mapAll(itemsOf(got.body)), next: nextOf(got.body), stale: got.stale }
}

/** One email by id (`reply_to_uuid`), or null when Instantly has none. */
export async function getEmail(id: string, opts: { fresh?: boolean } = {}): Promise<InboxEmail | null> {
  const got = await get(`/emails/${encodeURIComponent(id)}`, {}, TTL.email, opts.fresh === true)
  return got.body === NOT_FOUND ? null : mapInboxEmail(got.body)
}

/** Every email of a thread (`search=thread:<id>`, oldest first), up to 500. */
export async function getThreadEmails(threadId: string, opts: { fresh?: boolean } = {}): Promise<InboxEmail[]> {
  const out: InboxEmail[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const got = await get(
      '/emails',
      { search: `thread:${threadId}`, sort_order: 'asc', limit: String(PAGE), starting_after: cursor },
      TTL.thread,
      opts.fresh === true
    )
    if (got.body === NOT_FOUND) break
    const items = itemsOf(got.body)
    out.push(...mapAll(items))
    const next = nextOf(got.body)
    if (items.length < PAGE || !next) break
    cursor = next
  }
  return out
}
