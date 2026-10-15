/**
 * Pure query-building for `getLeadBank()`: filters become PostgREST calls on
 * the `lume_lead_bank` view, pagination becomes a `range`. Kept free of the
 * Supabase client so the mapping is unit-tested with a fake builder.
 *
 * The filter shape is the one `rotation_rules.filter` stores
 * ({source, icp_status, city, since}); `origin` is accepted as an alias of
 * `source` because that is the view's column name.
 */

export interface LeadBankFilter {
  /** View column `origin`: 'lead_bank' | 'validation_rows'. */
  origin?: string
  /** Alias of `origin` (the key rotation_rules.filter uses). */
  source?: string
  icp_status?: string
  /** Case-insensitive contains match on `city`. */
  city?: string
  /** ISO date/timestamp lower bound on `created_at`. */
  since?: string
}

/** The slice of PostgREST's filter builder the mapping needs. */
export interface LeadBankQuery<Q> {
  eq(column: string, value: string): Q
  ilike(column: string, pattern: string): Q
  gte(column: string, value: string): Q
}

export const LEAD_BANK_DEFAULT_PAGE_SIZE = 100
export const LEAD_BANK_MAX_PAGE_SIZE = 500

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined)

/** `%` and `_` are wildcards in `ilike`; a city named "50% off" must not match everything. */
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`)

export function applyLeadBankFilter<Q extends LeadBankQuery<Q>>(query: Q, filter: LeadBankFilter): Q {
  let q = query
  const origin = clean(filter.origin) ?? clean(filter.source)
  if (origin) q = q.eq('origin', origin)
  const icp = clean(filter.icp_status)
  if (icp) q = q.eq('icp_status', icp)
  const city = clean(filter.city)
  if (city) q = q.ilike('city', `%${escapeLike(city)}%`)
  const since = clean(filter.since)
  if (since) q = q.gte('created_at', since)
  return q
}

/** Zero-based inclusive `[from, to]` for `.range()`. Page is 1-based. */
export function pageRange(page: number, pageSize: number): [number, number] {
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  const size = Number.isFinite(pageSize) ? Math.min(Math.max(Math.floor(pageSize), 1), LEAD_BANK_MAX_PAGE_SIZE) : LEAD_BANK_DEFAULT_PAGE_SIZE
  const from = (p - 1) * size
  return [from, from + size - 1]
}

export interface LeadBankParams {
  filter: LeadBankFilter
  page: number
  pageSize: number
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/

function positiveInt(v: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (v === null) return fallback
  if (!/^\d+$/.test(v)) return fallback
  const n = Number(v)
  return n >= 1 ? Math.min(n, max) : fallback
}

/** `GET /api/lead-bank?origin=&icp_status=&city=&since=&page=&pageSize=` → params. */
export function parseLeadBankParams(sp: URLSearchParams): LeadBankParams {
  const filter: LeadBankFilter = {}
  const origin = clean(sp.get('origin') ?? undefined) ?? clean(sp.get('source') ?? undefined)
  if (origin) filter.origin = origin
  const icp = clean(sp.get('icp_status') ?? undefined)
  if (icp) filter.icp_status = icp
  const city = clean(sp.get('city') ?? undefined)
  if (city) filter.city = city
  const since = clean(sp.get('since') ?? undefined)
  if (since && ISO_DATE_RE.test(since)) filter.since = since
  return {
    filter,
    page: positiveInt(sp.get('page'), 1),
    pageSize: positiveInt(sp.get('pageSize'), LEAD_BANK_DEFAULT_PAGE_SIZE, LEAD_BANK_MAX_PAGE_SIZE),
  }
}

/** Builds the query string `parseLeadBankParams` reads (used by the hook). */
export function leadBankSearchParams(params: Partial<LeadBankParams>): string {
  const sp = new URLSearchParams()
  const f = params.filter ?? {}
  const origin = clean(f.origin) ?? clean(f.source)
  if (origin) sp.set('origin', origin)
  if (clean(f.icp_status)) sp.set('icp_status', f.icp_status!.trim())
  if (clean(f.city)) sp.set('city', f.city!.trim())
  if (clean(f.since)) sp.set('since', f.since!.trim())
  if (params.page && params.page > 1) sp.set('page', String(params.page))
  if (params.pageSize && params.pageSize !== LEAD_BANK_DEFAULT_PAGE_SIZE) sp.set('pageSize', String(params.pageSize))
  const s = sp.toString()
  return s ? `?${s}` : ''
}
