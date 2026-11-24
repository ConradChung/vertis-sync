import 'server-only'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PortalUser } from '@/lib/portal/access'
import type { PortalLead, PortalLeadsResponse, PortalReplyStatus, PortalSort, PortalTab } from '@/lib/portal/types'
import { stepLabel } from '@/lib/leads/steps'

/**
 * Scoped, read-only lead search for the client portal. Every query is bound
 * to the portal user's own `campaign_ids` / `linkedin_set_ids` / `sheet_set_ids` (from
 * `lume_portal_users`, never from the request) and selects only the columns
 * a `PortalLead` needs. Used by GET /api/portal/leads and the portal agent's
 * `search_leads` tool.
 */

export const PORTAL_PAGE_SIZE = 50

const EMAIL_VIEW = 'lume_portal_leads'
const LINKEDIN_VIEW = 'lume_portal_linkedin_leads'
const SHEET_VIEW = 'lume_portal_sheet_leads'

const EMAIL_COLUMNS =
  'id,campaign_name,region,timezone,first_name,last_name,email,company_name,website,company_domain,title,phone,phone_type,linkedin_url,city,state,country,email_open_count,email_reply_count,reply_status'
const LINKEDIN_COLUMNS =
  'id,list_title,first_name,last_name,full_name,title,company_name,website,company_domain,linkedin_url,email,phone,city,state,country,step_label'
const SHEET_COLUMNS =
  'id,list_title,company_name,person_name,title,category,phone,website,company_domain,email,linkedin_url,city,state,country,rating,step_label'

const boolParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

export const PortalLeadsQuerySchema = z.object({
  tab: z.enum(['email', 'linkedin', 'sheet']).default('email'),
  q: z.string().trim().max(200).optional().transform((v) => (v ? v : undefined)),
  region: z.string().trim().max(100).optional().transform((v) => (v ? v : undefined)),
  has_phone: boolParam.optional(),
  status: z.enum(['replied_positive']).optional(),
  sort: z.enum(['company', 'name', 'region']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
})

export type ParsedPortalLeadsQuery = z.infer<typeof PortalLeadsQuerySchema>

/** Parse `URLSearchParams` into a validated query. Unknown keys (e.g. `as`, `campaign_id`) are ignored. */
export function parsePortalLeadsQuery(params: URLSearchParams) {
  const raw: Record<string, string> = {}
  for (const k of ['tab', 'q', 'region', 'has_phone', 'status', 'sort', 'page']) {
    const v = params.get(k)
    if (v !== null && v !== '') raw[k] = v
  }
  return PortalLeadsQuerySchema.safeParse(raw)
}

/**
 * One search term as a quoted PostgREST `ilike` value for use inside `or=()`.
 *
 *  - LIKE wildcards the user typed (`%`, `_`) are escaped so they match
 *    literally;
 *  - `*` (PostgREST's wildcard), `"` and `\` become `_` (any one character)
 *    rather than being smuggled through;
 *  - the value is double-quoted so `,` `(` `)` `.` `:` cannot break out of the
 *    `or` list, with `\` escaped for PostgREST's quoted-string parser.
 */
export function ilikeOrValue(term: string): string {
  let pattern = ''
  for (const c of term) {
    if (c === '%' || c === '_') pattern += `\\${c}`
    else if (c === '*' || c === '"' || c === '\\') pattern += '_'
    else pattern += c
  }
  return `"*${pattern.replace(/\\/g, '\\\\')}*"`
}

const EMAIL_SEARCH_COLUMNS = ['first_name', 'last_name', 'company_name', 'email', 'title', 'phone', 'city']
const LINKEDIN_SEARCH_COLUMNS = ['full_name', 'first_name', 'last_name', 'company_name', 'email', 'title', 'phone', 'city']
const SHEET_SEARCH_COLUMNS = ['company_name', 'person_name', 'category', 'email', 'phone', 'city']

/**
 * The PostgREST `or` filter for a free-text query, or null when there is
 * nothing to search. On the email tab a two-word query also matches
 * first + last name ("jane doe").
 */
export function searchOrFilter(tab: PortalTab, q: string | undefined): string | null {
  const term = q?.replace(/\s+/g, ' ').trim().slice(0, 100)
  if (!term) return null
  const v = ilikeOrValue(term)
  const cols = tab === 'email' ? EMAIL_SEARCH_COLUMNS : tab === 'sheet' ? SHEET_SEARCH_COLUMNS : LINKEDIN_SEARCH_COLUMNS
  const parts = cols.map((c) => `${c}.ilike.${v}`)
  if (tab === 'email') {
    const words = term.split(' ')
    if (words.length === 2) {
      parts.push(`and(first_name.ilike.${ilikeOrValue(words[0])},last_name.ilike.${ilikeOrValue(words[1])})`)
    }
  }
  return parts.join(',')
}

const REPLY_STATUSES: ReadonlySet<string> = new Set<PortalReplyStatus>(['Interested', 'Meeting booked', 'Meeting completed', 'Won'])

type Row = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || 0 : 0)
const joinName = (...parts: Array<string | null>) => parts.filter(Boolean).join(' ').trim()

/** `lume_portal_leads` row → PortalLead (only contract fields). */
export function mapEmailRow(r: Row): PortalLead {
  const first = str(r.first_name)
  const email = str(r.email)
  const phoneType = r.phone_type === 'mobile' || r.phone_type === 'company' ? r.phone_type : null
  const reply = typeof r.reply_status === 'string' && REPLY_STATUSES.has(r.reply_status) ? (r.reply_status as PortalReplyStatus) : null
  return {
    id: String(r.id),
    kind: 'email',
    name: joinName(first, str(r.last_name)) || email || '',
    first_name: first,
    title: str(r.title),
    company: str(r.company_name),
    phone: str(r.phone),
    phone_type: phoneType,
    email,
    website: str(r.website) ?? str(r.company_domain),
    linkedin_url: str(r.linkedin_url),
    city: str(r.city),
    state: str(r.state),
    country: str(r.country),
    region: str(r.region),
    timezone: str(r.timezone),
    campaign: str(r.campaign_name),
    reply_status: reply,
    opened: num(r.email_open_count) > 0,
    replied: num(r.email_reply_count) > 0,
    // Every lead on this tab was pushed to its campaign (the view keeps pushed leads only).
    step: stepLabel(5),
  }
}

/** `lume_portal_linkedin_leads` row → PortalLead (only contract fields). */
export function mapLinkedinRow(r: Row): PortalLead {
  const first = str(r.first_name)
  const email = str(r.email)
  return {
    id: String(r.id),
    kind: 'linkedin',
    name: str(r.full_name)?.trim() || joinName(first, str(r.last_name)) || email || '',
    first_name: first,
    title: str(r.title),
    company: str(r.company_name),
    phone: str(r.phone),
    phone_type: null,
    email,
    website: str(r.website) ?? str(r.company_domain),
    linkedin_url: str(r.linkedin_url),
    city: str(r.city),
    state: str(r.state),
    country: str(r.country),
    region: null,
    timezone: null,
    campaign: str(r.list_title),
    reply_status: null,
    opened: false,
    replied: false,
    step: str(r.step_label),
  }
}

const rating = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : null
}

/** `lume_portal_sheet_leads` row → PortalLead: one business per row (its name in `name`, a contact person, if any, as the title). */
export function mapSheetRow(r: Row): PortalLead {
  const company = str(r.company_name)
  const person = str(r.person_name)
  return {
    id: String(r.id),
    kind: 'sheet',
    name: company ?? person ?? str(r.email) ?? '',
    first_name: null,
    title: company && person ? person : str(r.title),
    company,
    phone: str(r.phone),
    phone_type: str(r.phone) ? 'company' : null,
    email: str(r.email),
    website: str(r.website) ?? str(r.company_domain),
    linkedin_url: str(r.linkedin_url),
    city: str(r.city),
    state: str(r.state),
    country: str(r.country),
    region: null,
    timezone: null,
    campaign: str(r.list_title),
    reply_status: null,
    opened: false,
    replied: false,
    step: str(r.step_label),
    rating: rating(r.rating),
    category: str(r.category),
  }
}

const VIEWS: Record<PortalTab, { view: string; columns: string; scope: string; map: (r: Row) => PortalLead }> = {
  email: { view: EMAIL_VIEW, columns: EMAIL_COLUMNS, scope: 'campaign_id', map: mapEmailRow },
  linkedin: { view: LINKEDIN_VIEW, columns: LINKEDIN_COLUMNS, scope: 'set_id', map: mapLinkedinRow },
  sheet: { view: SHEET_VIEW, columns: SHEET_COLUMNS, scope: 'set_id', map: mapSheetRow },
}

export interface PortalSearchOptions {
  tab: PortalTab
  q?: string
  region?: string
  has_phone?: boolean
  status?: 'replied_positive'
  sort?: PortalSort
  page?: number
  pageSize?: number
}

export class PortalQueryError extends Error {}

/** The ids this user may read on a tab. Always from the portal user row. */
export function scopeIds(user: PortalUser, tab: PortalTab): string[] {
  return tab === 'email' ? user.campaign_ids : tab === 'sheet' ? (user.sheet_set_ids ?? []) : user.linkedin_set_ids
}

/**
 * One page of the user's leads on a tab. Empty (no query) when the user has
 * no ids on that tab or a filter cannot match there (status / region on the
 * LinkedIn tab, which has neither replies nor regions).
 */
export async function searchPortalLeads(
  db: SupabaseClient,
  user: PortalUser,
  opts: PortalSearchOptions
): Promise<{ rows: PortalLead[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(PORTAL_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize ?? PORTAL_PAGE_SIZE)))
  const empty = { rows: [], total: 0, page, pageSize }
  const ids = scopeIds(user, opts.tab)
  if (ids.length === 0) return empty

  const email = opts.tab === 'email'
  if (!email && (opts.status === 'replied_positive' || opts.region)) return empty

  const v = VIEWS[opts.tab]
  let query = db.from(v.view).select(v.columns, { count: 'exact' }).in(v.scope, ids)

  const or = searchOrFilter(opts.tab, opts.q)
  if (or) query = query.or(or)
  if (opts.has_phone) query = query.not('phone', 'is', null)
  if (email && opts.region) query = query.eq('region', opts.region)
  if (email && opts.status === 'replied_positive') query = query.not('reply_status', 'is', null)

  const sort = opts.sort ?? 'company'
  const order: string[] =
    sort === 'name'
      ? email
        ? ['first_name', 'last_name']
        : opts.tab === 'sheet'
          ? ['company_name']
          : ['full_name']
      : sort === 'region' && email
        ? ['region', 'company_name']
        : ['company_name']
  for (const col of order) query = query.order(col, { ascending: true, nullsFirst: false })
  query = query.order('id', { ascending: true })

  const from = (page - 1) * pageSize
  const { data, count, error } = await query.range(from, from + pageSize - 1)
  if (error) throw new PortalQueryError(error.message)
  const rows = ((data ?? []) as unknown as Row[]).map(v.map)
  return { rows, total: count ?? rows.length, page, pageSize }
}

const REGION_TTL_MS = 5 * 60_000
const REGION_CHUNK = 1000
const REGION_MAX_CHUNKS = 20
const regionCache = new Map<string, { at: number; regions: string[] }>()

/** Test hook. */
export function clearPortalRegionCache() {
  regionCache.clear()
}

/**
 * Distinct non-null regions across the user's leads on a tab (the LinkedIn
 * tab has none). PostgREST has no DISTINCT, so the region column is read in
 * chunks and de-duplicated; cached per user for a few minutes.
 */
export async function portalRegions(db: SupabaseClient, user: PortalUser, tab: PortalTab): Promise<string[]> {
  if (tab !== 'email' || user.campaign_ids.length === 0) return []
  const key = `${user.email}|${[...user.campaign_ids].sort().join(',')}`
  const hit = regionCache.get(key)
  if (hit && Date.now() - hit.at < REGION_TTL_MS) return hit.regions

  const seen = new Set<string>()
  for (let i = 0; i < REGION_MAX_CHUNKS; i++) {
    const { data, error } = await db
      .from(EMAIL_VIEW)
      .select('region')
      .in('campaign_id', user.campaign_ids)
      .not('region', 'is', null)
      .order('region', { ascending: true })
      .order('id', { ascending: true })
      .range(i * REGION_CHUNK, (i + 1) * REGION_CHUNK - 1)
    if (error) throw new PortalQueryError(error.message)
    const rows = (data ?? []) as Array<{ region: unknown }>
    for (const r of rows) if (typeof r.region === 'string' && r.region.trim()) seen.add(r.region)
    if (rows.length < REGION_CHUNK) break
  }
  const regions = [...seen].sort((a, b) => a.localeCompare(b))
  regionCache.set(key, { at: Date.now(), regions })
  return regions
}

/** GET /api/portal/leads body. */
export async function portalLeadsResponse(
  db: SupabaseClient,
  user: PortalUser,
  q: ParsedPortalLeadsQuery
): Promise<PortalLeadsResponse> {
  const [page, regions] = await Promise.all([searchPortalLeads(db, user, q), portalRegions(db, user, q.tab)])
  return { ...page, regions }
}
