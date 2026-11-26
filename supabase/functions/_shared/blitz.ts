// BlitzAPI client shared by the edge functions (contact-email-finder, the
// signal contacts stage). Lume's hiring signal has a twin in lume/lib/blitz.ts;
// keep the two in step.
//
// Docs (take shapes from these, not from memory):
//   GET  /v2/account/key-info          0 records   valid, records_remaining, max_requests_per_seconds
//   POST /v2/enrichment/email          1 record on found:true, 0 on a miss
//   POST /v2/enrichment/domain-to-linkedin  1 record on found:true
//   POST /v2/search/waterfall-icp-keyword   1 record per result returned
//
// Rules this module keeps:
//  - Pacing: one pacer per session, every HTTP attempt (retries included)
//    waits on it, so starts are >= 250 ms apart (4/s, under the key's 5/s).
//  - 429 / 500 / 503: the same request is asked again after a short wait
//    (bounded); a 429 also holds every caller for that wait.
//  - Records guard: key-info is read once per session and a local countdown
//    is kept from the `fair_usage` each answer carries; at 0 (or a 402) the
//    session stops calling.
//  - Never throws: a missing / invalid key, exhausted records, a timeout or a
//    5xx come back as { kind: 'unavailable' } and the caller carries on.
//  - The key is only ever put in the x-api-key header; it is never logged.
import { makePacer } from './pacer.ts'

export const BLITZ_BASE = 'https://api.blitz-api.ai'
/** Starts at least this far apart: 4/s, under the trial key's 5/s per endpoint. */
export const BLITZ_INTERVAL_MS = 250
/** Rows in flight at once (contact-email-finder). */
export const BLITZ_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 15_000
/** Waits before re-asking after a 429 / 5xx (the API's Retry-After is 1 s). */
const DEFAULT_RETRY_WAITS = [1_000, 2_000] as const

export type UnavailableReason =
  | 'no_key' // BLITZ_API_KEY not set
  | 'invalid_key' // 401 (or key-info valid:false)
  | 'exhausted' // records countdown at 0, a 402, or this session's own record budget used up
  | 'locked' // 423: account locked by Blitz
  | 'rate_limited' // still 429 after the bounded retries
  | 'server_error' // still 5xx after the bounded retries
  | 'timeout'
  | 'network'
  | 'bad_request' // 400 / 422: this input, not the service

export type Unavailable = { kind: 'unavailable'; reason: UnavailableReason; status?: number }
export type Miss = { kind: 'miss' }

export type EmailLookup = { kind: 'found'; email: string } | Miss | Unavailable
export type CompanyLookup = { kind: 'found'; companyLinkedinUrl: string; companyName: string | null } | Miss | Unavailable

export interface IcpPerson {
  name: string
  firstName: string | null
  lastName: string | null
  title: string | null
  linkedinUrl: string
  /** 1-based cascade tier that matched */
  tier: number | null
}
export type IcpLookup = { kind: 'found'; people: IcpPerson[] } | Miss | Unavailable

export interface KeyInfo {
  valid: boolean
  /** null = the plan has no record limit ("unlimited") */
  recordsRemaining: number | null
  maxRequestsPerSecond: number | null
  allowedApis: string[]
  nextResetAt: string | null
}

export interface IcpTier {
  include_title: string[]
  exclude_title?: string[]
  include_headline_search?: boolean
}

export interface BlitzOptions {
  apiKey: string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  intervalMs?: number
  timeoutMs?: number
  retryWaits?: readonly number[]
  /** Most records this session may use, on top of the account's own countdown. */
  maxRecords?: number
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** A LinkedIn person profile URL Blitz accepts (linkedin.com/in/<slug>), normalised; else null. */
export function personLinkedinUrl(raw: unknown): string | null {
  const s = str(raw)
  if (!s) return null
  const m = /(?:^|\/\/|\.)linkedin\.com\/in\/([^/?#\s]+)/i.exec(s.startsWith('http') ? s : `https://${s.replace(/^\/+/, '')}`)
  if (!m) return null
  let slug = m[1]
  try { slug = decodeURIComponent(slug) } catch { /* keep as is */ }
  slug = slug.trim()
  return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}` : null
}

export class BlitzSession {
  private readonly f: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pacer: () => Promise<void>
  private readonly timeoutMs: number
  private readonly retryWaits: readonly number[]
  private readonly maxRecords: number | null
  private holdUntil = 0
  private startP: Promise<void> | null = null
  /** null until key-info is read; then a number, or null again for an unlimited plan (see `unlimited`). */
  private remaining: number | null = null
  private unlimited = false
  private disabled: UnavailableReason | null = null
  /** Records this session spent (from Blitz's own fair_usage). */
  recordsUsed = 0
  /** HTTP attempts sent (key-info included) — for logs and tests. */
  requests = 0

  constructor(private readonly opts: BlitzOptions) {
    this.f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    this.pacer = makePacer(opts.intervalMs ?? BLITZ_INTERVAL_MS, this.now, this.sleep)
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retryWaits = opts.retryWaits ?? DEFAULT_RETRY_WAITS
    this.maxRecords = typeof opts.maxRecords === 'number' ? Math.max(0, opts.maxRecords) : null
    if (!opts.apiKey?.trim()) this.disabled = 'no_key'
  }

  get configured(): boolean {
    return !!this.opts.apiKey?.trim()
  }

  /** Why the session stopped calling, or null while it still can. */
  get unavailableReason(): UnavailableReason | null {
    return this.disabled
  }

  /** Account records left as last seen (null before key-info, or unlimited). */
  get recordsRemaining(): number | null {
    return this.unlimited ? null : this.remaining
  }

  /** True while a call costing `cost` records may still be made. Reads key-info first if needed. */
  async canSpend(cost = 1): Promise<boolean> {
    await this.start()
    return this.budgetFor(cost) === null
  }

  private budgetFor(cost: number): UnavailableReason | null {
    if (this.disabled) return this.disabled
    if (this.maxRecords !== null && this.recordsUsed + cost > this.maxRecords) return 'exhausted'
    if (!this.unlimited && this.remaining !== null && this.remaining < cost) return 'exhausted'
    return null
  }

  /** Free (0 records). Never throws. */
  async keyInfo(): Promise<KeyInfo | Unavailable> {
    if (!this.configured) return { kind: 'unavailable', reason: 'no_key' }
    const res = await this.send('GET', '/v2/account/key-info')
    if ('kind' in res) return res.kind === 'miss' ? { kind: 'unavailable', reason: 'network', status: 404 } : res
    const b = res.body as Record<string, unknown>
    const rr = b.records_remaining
    const rps = b.max_requests_per_seconds
    return {
      valid: b.valid === true,
      recordsRemaining: rr === 'unlimited' ? null : num(rr) ?? 0,
      maxRequestsPerSecond: rps === 'unlimited' ? null : num(rps),
      allowedApis: Array.isArray(b.allowed_apis) ? b.allowed_apis.filter((x): x is string => typeof x === 'string') : [],
      nextResetAt: str(b.next_reset_at),
    }
  }

  /** Reads key-info once per session and seeds the records countdown. */
  start(): Promise<void> {
    if (!this.startP) {
      this.startP = (async () => {
        if (this.disabled) return
        const info = await this.keyInfo()
        if ('kind' in info) {
          // invalid_key / exhausted / locked already disabled the session in send();
          // a transient failure (timeout, 5xx) also stops it for this run: no countdown, no calls.
          this.disabled ??= info.reason
          return
        }
        if (!info.valid) {
          this.disabled = 'invalid_key'
          return
        }
        if (info.recordsRemaining === null) this.unlimited = true
        else this.remaining = info.recordsRemaining
        if (!this.unlimited && (this.remaining ?? 0) <= 0) this.disabled = 'exhausted'
      })()
    }
    return this.startP
  }

  /** Verified work email from a LinkedIn profile URL. 1 record when found, 0 on a miss. */
  async findWorkEmail(linkedinUrl: string): Promise<EmailLookup> {
    const url = personLinkedinUrl(linkedinUrl)
    if (!url) return { kind: 'unavailable', reason: 'bad_request' }
    const res = await this.call('/v2/enrichment/email', { person_linkedin_url: url }, 1)
    if ('kind' in res) return res
    const b = res.body as Record<string, unknown>
    const email = str(b.email)
    return b.found === true && email && email.includes('@') ? { kind: 'found', email: email.toLowerCase() } : { kind: 'miss' }
  }

  /** Company LinkedIn page from a website domain. 1 record when found. */
  async domainToLinkedin(domain: string): Promise<CompanyLookup> {
    if (!str(domain)) return { kind: 'unavailable', reason: 'bad_request' }
    const res = await this.call('/v2/enrichment/domain-to-linkedin', { domain: domain.trim() }, 1)
    if ('kind' in res) return res
    const b = res.body as Record<string, unknown>
    const url = str(b.company_linkedin_url)
    return b.found === true && url ? { kind: 'found', companyLinkedinUrl: url, companyName: str(b.company_name) } : { kind: 'miss' }
  }

  /** Best-fit people at one company from a prioritised title cascade. 1 record per person returned. */
  async waterfallIcp(companyLinkedinUrl: string, cascade: IcpTier[], maxResults = 1): Promise<IcpLookup> {
    if (!str(companyLinkedinUrl) || !cascade.length) return { kind: 'unavailable', reason: 'bad_request' }
    const max = Math.max(1, Math.floor(maxResults))
    const res = await this.call('/v2/search/waterfall-icp-keyword', { company_linkedin_url: companyLinkedinUrl, cascade, max_results: max }, max)
    if ('kind' in res) return res
    const b = res.body as Record<string, unknown>
    const results = Array.isArray(b.results) ? b.results as Record<string, unknown>[] : []
    const people: IcpPerson[] = []
    for (const r of results) {
      const p = (r?.person ?? {}) as Record<string, unknown>
      const li = personLinkedinUrl(p.linkedin_url)
      if (!li) continue
      const exps = Array.isArray(p.experiences) ? p.experiences as Record<string, unknown>[] : []
      const first = str(p.first_name)
      const last = str(p.last_name)
      people.push({
        name: str(p.full_name) ?? [first, last].filter(Boolean).join(' '),
        firstName: first,
        lastName: last,
        title: str(exps[0]?.job_title) ?? str(p.headline)?.split(' | @')[0] ?? null,
        linkedinUrl: li,
        tier: num(r.icp),
      })
    }
    return people.length ? { kind: 'found', people } : { kind: 'miss' }
  }

  // ---------------------------------------------------------------------------

  private async call(path: string, body: unknown, maxCost: number): Promise<{ body: unknown } | Unavailable | Miss> {
    await this.start()
    const blocked = this.budgetFor(maxCost)
    if (blocked) return { kind: 'unavailable', reason: blocked }
    return await this.send('POST', path, body)
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ body: unknown } | Unavailable | Miss> {
    for (let attempt = 0; ; attempt++) {
      await this.pacer()
      const hold = this.holdUntil - this.now()
      if (hold > 0) await this.sleep(hold)
      let res: Response
      this.requests++
      try {
        res = await this.f(`${BLITZ_BASE}${path}`, {
          method,
          headers: { 'x-api-key': this.opts.apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (err) {
        // A read timeout is not retried: Blitz may already have counted the record.
        const name = (err as { name?: string })?.name
        return { kind: 'unavailable', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
      }
      let parsed: unknown = null
      try {
        parsed = await res.json()
      } catch {
        parsed = null
      }
      this.account(res, parsed)
      if (res.ok) return { body: parsed ?? {} }
      const s = res.status
      if (s === 401 || s === 403) {
        this.disabled = 'invalid_key'
        return { kind: 'unavailable', reason: 'invalid_key', status: s }
      }
      if (s === 402) {
        this.disabled = 'exhausted'
        this.remaining = 0
        this.unlimited = false
        return { kind: 'unavailable', reason: 'exhausted', status: s }
      }
      if (s === 423) {
        this.disabled = 'locked'
        return { kind: 'unavailable', reason: 'locked', status: s }
      }
      if (s === 404) return { kind: 'miss' }
      const retryable = s === 429 || s === 500 || s === 502 || s === 503 || s === 504
      if (!retryable) return { kind: 'unavailable', reason: 'bad_request', status: s }
      const wait = this.retryWaits[attempt]
      if (wait === undefined) return { kind: 'unavailable', reason: s === 429 ? 'rate_limited' : 'server_error', status: s }
      if (s === 429) this.holdUntil = Math.max(this.holdUntil, this.now() + wait) // slow every caller down
      await this.sleep(wait)
    }
  }

  /** Updates the countdown from the answer's fair_usage (or x-records-* headers). */
  private account(res: Response, body: unknown): void {
    const fu = (body && typeof body === 'object' ? (body as Record<string, unknown>).fair_usage : null) as Record<string, unknown> | null
    const used = num(fu?.records_used) ?? num(Number(res.headers.get('x-records-used') ?? NaN)) ?? 0
    if (used > 0) this.recordsUsed += used
    const rr = fu?.records_remaining ?? res.headers.get('x-records-remaining')
    if (rr === 'unlimited') {
      this.unlimited = true
      return
    }
    const left = num(typeof rr === 'string' ? Number(rr) : rr)
    if (left !== null) this.remaining = left
    else if (used > 0 && this.remaining !== null) this.remaining = Math.max(0, this.remaining - used)
    if (!this.unlimited && this.remaining !== null && this.remaining <= 0 && !this.disabled) this.disabled = 'exhausted'
  }
}

/** Decision-maker cascade for a property-management company (owner's priority order). */
export const DECISION_MAKER_CASCADE: IcpTier[] = [
  { include_title: ['Owner', 'Principal', 'Founder', 'Co-Founder', 'Managing Partner', 'President', 'CEO', 'Chief Executive Officer'], exclude_title: ['assistant', 'intern', 'vice president', 'product owner', 'engineer'] },
  { include_title: ['COO', 'Chief Operating Officer', 'Head of Operations', 'Head of Asset Management'], exclude_title: ['assistant', 'intern'] },
  { include_title: ['VP Property Management', 'Vice President Property Management', 'Director of Property Management', 'Property Management Director'], exclude_title: ['assistant', 'intern'] },
]
