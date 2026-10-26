import { z } from 'zod'
import { domainOf, normaliseRecord } from '@/lib/apollo/records'

/**
 * Lead review sets: an actor's results copied into Lume so the owner (and the
 * agent, on the owner's say-so) can inspect them and exclude the irrelevant
 * ones before a manual Apollo export. Pure model: normalisation, filter
 * matching, histograms. No I/O.
 */

export const REVIEW_MAX_ITEMS = 5000

export interface LeadItem {
  name: string | null
  company: string | null
  first_name: string | null
  last_name: string | null
  title: string | null
  website: string | null
  domain: string | null
  category: string | null
  city: string | null
  state: string | null
  country: string | null
  phone: string | null
  rating: number | null
  reviews_count: number | null
  linkedin_url: string | null
  email: string | null
}

export interface ReviewRow {
  idx: number
  item: LeadItem
  status: 'kept' | 'excluded'
  excluded_reason: string | null
  filter_id: string | null
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)

function field(row: Record<string, unknown>, keys: string[]): unknown {
  const index = new Map<string, unknown>()
  for (const [k, v] of Object.entries(row)) index.set(k.toLowerCase().replace(/[\s_.-]/g, ''), v)
  for (const k of keys) {
    const v = index.get(k)
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/** Normalise one scraped row (Google Maps, directories, LinkedIn, CSV rows) into the review fields. */
export function normaliseLead(raw: Record<string, unknown>): LeadItem {
  const r = normaliseRecord(raw)
  const categories = field(raw, ['categories'])
  const category = s(field(raw, ['categoryname', 'category', 'industry', 'type', 'businesstype'])) ?? (Array.isArray(categories) ? s(categories[0]) : null)
  const person = [r.first_name, r.last_name].filter(Boolean).join(' ') || null
  const phone = s(field(raw, ['phone', 'phonenumber', 'phoneunformatted', 'telephone', 'mobile', 'companyphone']))
  return {
    name: r.company ?? person,
    company: r.company,
    first_name: r.first_name,
    last_name: r.last_name,
    title: r.title,
    website: r.website,
    domain: r.domain ?? domainOf(r.website),
    category,
    city: r.city,
    state: r.state,
    country: r.country,
    phone,
    rating: num(field(raw, ['totalscore', 'rating', 'stars', 'averagerating'])),
    reviews_count: num(field(raw, ['reviewscount', 'reviews', 'reviewcount', 'userratingstotal'])),
    linkedin_url: r.linkedin_url,
    email: r.email,
  }
}

export const MISSING_FIELDS = ['website', 'phone', 'email', 'linkedin'] as const

export const FilterCriteria = z
  .object({
    categories_in: z.array(z.string().min(1).max(120)).max(50).optional().describe('category is one of these (case-insensitive)'),
    categories_not_in: z.array(z.string().min(1).max(120)).max(50).optional().describe('category is none of these'),
    keywords: z.array(z.string().min(2).max(80)).max(30).optional().describe('name or category contains any of these words (case-insensitive)'),
    cities: z.array(z.string().min(1).max(120)).max(50).optional(),
    states: z.array(z.string().min(1).max(60)).max(60).optional(),
    rating_below: z.number().min(0).max(5).optional(),
    reviews_below: z.number().int().min(0).max(1_000_000).optional(),
    missing: z.array(z.enum(MISSING_FIELDS)).max(4).optional().describe('item lacks any of these fields'),
    duplicate_domain: z.boolean().optional().describe('a later row whose domain already appeared among kept rows'),
    item_ids: z.array(z.number().int().min(0)).max(REVIEW_MAX_ITEMS).optional().describe('explicit row numbers (idx)'),
  })
  .refine((c) => Object.values(c).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined)), 'at least one criterion')
export type FilterCriteria = z.infer<typeof FilterCriteria>

const lower = (v: string | null) => (v ?? '').toLowerCase()
const has = (item: LeadItem, f: (typeof MISSING_FIELDS)[number]) =>
  f === 'website' ? !!(item.website || item.domain) : f === 'linkedin' ? !!item.linkedin_url : !!item[f]

/**
 * Rows matching every given criterion (AND). `duplicate_domain` looks at the
 * kept rows in idx order, so the first row of each domain is never a duplicate.
 */
export function matchRows(rows: readonly ReviewRow[], c: FilterCriteria): Set<number> {
  const inSet = (xs?: string[]) => (xs?.length ? new Set(xs.map((x) => x.toLowerCase().trim())) : null)
  const catIn = inSet(c.categories_in)
  const catOut = inSet(c.categories_not_in)
  const cities = inSet(c.cities)
  const states = inSet(c.states)
  const ids = c.item_ids?.length ? new Set(c.item_ids) : null
  const words = c.keywords?.map((w) => w.toLowerCase())
  const dupes = new Set<number>()
  if (c.duplicate_domain) {
    const seen = new Set<string>()
    for (const r of [...rows].sort((a, b) => a.idx - b.idx)) {
      if (r.status !== 'kept' || !r.item.domain) continue
      if (seen.has(r.item.domain)) dupes.add(r.idx)
      else seen.add(r.item.domain)
    }
  }
  const out = new Set<number>()
  for (const r of rows) {
    const it = r.item
    if (ids && !ids.has(r.idx)) continue
    if (catIn && !catIn.has(lower(it.category))) continue
    if (catOut && catOut.has(lower(it.category))) continue
    if (words && !words.some((w) => lower(it.name).includes(w) || lower(it.category).includes(w))) continue
    if (cities && !cities.has(lower(it.city))) continue
    if (states && !states.has(lower(it.state))) continue
    if (c.rating_below !== undefined && !(it.rating !== null && it.rating < c.rating_below)) continue
    if (c.reviews_below !== undefined && !((it.reviews_count ?? 0) < c.reviews_below)) continue
    if (c.missing?.length && !c.missing.some((f) => !has(it, f))) continue
    if (c.duplicate_domain && !dupes.has(r.idx)) continue
    out.add(r.idx)
  }
  return out
}

export type FilterAction = 'exclude' | 'keep_only'

/**
 * Which rows change. `exclude`: kept rows that match become excluded.
 * `keep_only`: kept rows that do NOT match become excluded.
 */
export function planFilter(rows: readonly ReviewRow[], c: FilterCriteria, action: FilterAction): number[] {
  const hit = matchRows(rows, c)
  return rows.filter((r) => r.status === 'kept' && (action === 'exclude' ? hit.has(r.idx) : !hit.has(r.idx))).map((r) => r.idx)
}

export interface Histogram {
  value: string
  count: number
}

function top(values: (string | null)[], n: number): Histogram[] {
  const m = new Map<string, number>()
  for (const v of values) {
    const k = v?.trim() || '(none)'
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([value, count]) => ({ value, count }))
}

export interface ReviewSummary {
  total: number
  kept: number
  excluded: number
  coverage: { website: number; phone: number; email: number; linkedin: number }
  categories: Histogram[]
  cities: Histogram[]
  states: Histogram[]
  rating: { below_4: number; '4_to_4.5': number; '4.5_plus': number; none: number }
  duplicate_domains: number
}

/** Summary over the kept rows (what would be exported), plus overall counts. */
export function summarise(rows: readonly ReviewRow[]): ReviewSummary {
  const kept = rows.filter((r) => r.status === 'kept')
  const items = kept.map((r) => r.item)
  const domains = new Set<string>()
  let dup = 0
  for (const it of items) {
    if (!it.domain) continue
    if (domains.has(it.domain)) dup++
    else domains.add(it.domain)
  }
  return {
    total: rows.length,
    kept: kept.length,
    excluded: rows.length - kept.length,
    coverage: {
      website: items.filter((i) => has(i, 'website')).length,
      phone: items.filter((i) => has(i, 'phone')).length,
      email: items.filter((i) => has(i, 'email')).length,
      linkedin: items.filter((i) => has(i, 'linkedin')).length,
    },
    categories: top(items.map((i) => i.category), 15),
    cities: top(items.map((i) => i.city), 15),
    states: top(items.map((i) => i.state), 10),
    rating: {
      below_4: items.filter((i) => i.rating !== null && i.rating < 4).length,
      '4_to_4.5': items.filter((i) => i.rating !== null && i.rating >= 4 && i.rating < 4.5).length,
      '4.5_plus': items.filter((i) => i.rating !== null && i.rating >= 4.5).length,
      none: items.filter((i) => i.rating === null).length,
    },
    duplicate_domains: dup,
  }
}

/** Plain-English label for an applied filter chip. */
export function describeCriteria(c: FilterCriteria, action: FilterAction): string {
  const parts: string[] = []
  if (c.categories_in?.length) parts.push(`category is ${c.categories_in.join(' / ')}`)
  if (c.categories_not_in?.length) parts.push(`category not ${c.categories_not_in.join(' / ')}`)
  if (c.keywords?.length) parts.push(`name/category has “${c.keywords.join('” or “')}”`)
  if (c.cities?.length) parts.push(`city ${c.cities.join(' / ')}`)
  if (c.states?.length) parts.push(`state ${c.states.join(' / ')}`)
  if (c.rating_below !== undefined) parts.push(`rating < ${c.rating_below}`)
  if (c.reviews_below !== undefined) parts.push(`< ${c.reviews_below} reviews`)
  if (c.missing?.length) parts.push(`no ${c.missing.join(' or ')}`)
  if (c.duplicate_domain) parts.push('duplicate domain')
  if (c.item_ids?.length) parts.push(`${c.item_ids.length} picked row${c.item_ids.length === 1 ? '' : 's'}`)
  return `${action === 'exclude' ? 'Exclude' : 'Keep only'}: ${parts.join(', ')}`
}
