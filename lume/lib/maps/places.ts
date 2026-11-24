import { domainOf } from '@/lib/apollo/records'
import { csvCell } from '@/lib/csv/cell'
import type { Cells } from '@/lib/leads/columns'
import type { ListItem } from '@/lib/leads/lists/model'

/**
 * GTM-12, step 2 (pure): Google Maps places (compass/crawler-google-places
 * dataset items) → the cleaned Maps sheet.
 *
 *  - normalizePlace: one dataset item → a MapsPlace (null when it isn't a place).
 *  - cleanPlaces:    drop places that are permanently closed or have no website
 *                    of their own (none, or only a social / directory page), then
 *                    keep one place per company domain (the one with the most
 *                    reviews; how many Maps listings shared it is kept as
 *                    `branches`). Every drop is counted by reason.
 *  - sheetRow:       a kept place as a lead-list row: the sheet's own columns
 *                    (MAPS_SHEET_COLUMNS) as cells, a normalised lead item for
 *                    dedupe / phone / city, and the raw place.
 *
 * The sheet is the "Imported" step of GTM-18's numbering: every row has a
 * company, an office phone where Maps lists one, the city, the website and the
 * rating. The PM-vs-vendor check and the LinkedIn link come later from the
 * crawl worker; `Maps PM` is only Google's own category, a free first hint.
 */

export interface MapsPlace {
  name: string
  website: string | null
  /** Dedupe key: the company's registrable domain, or the full host on a site builder / PM-software platform. */
  domain: string | null
  /** As Maps shows it, e.g. "(310) 555-0134". */
  phone: string | null
  /** E.164 when Maps gives it ("+13105550134"), for tap-to-call. */
  phone_e164: string | null
  address: string | null
  street: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country_code: string | null
  rating: number | null
  reviews: number | null
  category: string | null
  categories: string[]
  permanently_closed: boolean
  temporarily_closed: boolean
  place_id: string | null
  maps_url: string | null
  search: string | null
}

type Raw = Record<string, unknown>

const str = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s : null
}
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const bool = (v: unknown) => v === true || v === 'true'

/** Hosts where many unrelated companies live on subdomains: key on the full host. */
const PLATFORM_HOSTS = /(^|\.)(appfolio\.com|managebuilding\.com|buildium\.com|rentmanager\.com|propertyware\.com|rentcafe\.com|wixsite\.com|squarespace\.com|godaddysites\.com|weebly\.com|square\.site|wordpress\.com|myshopify\.com|webflow\.io|carrd\.co|netlify\.app|vercel\.app)$/

/** A website that is not the company's own: social pages, directories, link pages, listing portals. */
const NOT_OWN_SITE =
  /(^|\.)(facebook\.com|fb\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|yelp\.com|nextdoor\.com|linktr\.ee|g\.page|goo\.gl|google\.com|zillow\.com|trulia\.com|apartments\.com|realtor\.com|redfin\.com|hotpads\.com|craigslist\.org|bbb\.org|yellowpages\.com|angi\.com|homeadvisor\.com|thumbtack\.com|mapquest\.com|business\.site)$/

const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/

/** The dedupe key for a company website, or null when it is not the company's own site. */
export function placeDomain(website: string | null): string | null {
  const host = domainOf(website)
  if (!host) return null
  if (NOT_OWN_SITE.test(host)) return null
  if (PLATFORM_HOSTS.test(host)) {
    // The platform's bare domain (no company subdomain) says nothing about the company.
    return host.split('.').length > 2 ? host : null
  }
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join('.')
  return SECOND_LEVEL.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo
}

/** One dataset item → a place, or null when it has no name (not a place row). */
export function normalizePlace(raw: Raw): MapsPlace | null {
  const name = str(raw.title) ?? str(raw.name)
  if (!name) return null
  const website = str(raw.website)
  const categories = Array.isArray(raw.categories) ? raw.categories.map(str).filter((x): x is string => !!x) : []
  const e164 = str(raw.phoneUnformatted)
  return {
    name,
    website,
    domain: placeDomain(website),
    phone: str(raw.phone) ?? e164,
    phone_e164: e164 && /^\+\d{8,15}$/.test(e164) ? e164 : null,
    address: str(raw.address),
    street: str(raw.street),
    city: str(raw.city),
    state: str(raw.state),
    postal_code: str(raw.postalCode),
    country_code: str(raw.countryCode),
    rating: num(raw.totalScore),
    reviews: num(raw.reviewsCount),
    category: str(raw.categoryName) ?? categories[0] ?? null,
    categories,
    permanently_closed: bool(raw.permanentlyClosed),
    temporarily_closed: bool(raw.temporarilyClosed),
    place_id: str(raw.placeId),
    maps_url: str(raw.url),
    search: str(raw.searchString),
  }
}

/** Google's own category says property management (a free hint, not the crawl worker's verdict). */
export function isPmCategory(p: Pick<MapsPlace, 'category' | 'categories'>): boolean {
  return [p.category, ...p.categories].some((c) => !!c && /property manage/i.test(c))
}

export type DropReason = 'not_a_place' | 'permanently_closed' | 'no_website' | 'not_own_website' | 'duplicate_domain'

export interface KeptPlace extends MapsPlace {
  domain: string
  /** Maps listings (offices / duplicates) that shared this domain, this one included. */
  branches: number
}

export interface CleanResult {
  kept: KeptPlace[]
  dropped: Record<DropReason, number>
  /** Items read from the dataset. */
  total: number
}

/** Fuller listings win a domain: more reviews, then a phone, then a rating. */
const score = (p: MapsPlace) => (p.reviews ?? 0) * 10 + (p.phone ? 5 : 0) + (p.rating ?? 0)

/**
 * Closed / no own website / duplicate domains out, in that order. Output
 * order: Maps PM category first, then most reviews, then name — the order a
 * caller would work down the sheet.
 */
export function cleanPlaces(items: readonly Raw[]): CleanResult {
  const dropped: Record<DropReason, number> = { not_a_place: 0, permanently_closed: 0, no_website: 0, not_own_website: 0, duplicate_domain: 0 }
  const byDomain = new Map<string, KeptPlace>()
  for (const raw of items) {
    const p = raw && typeof raw === 'object' ? normalizePlace(raw) : null
    if (!p) {
      dropped.not_a_place++
      continue
    }
    if (p.permanently_closed) {
      dropped.permanently_closed++
      continue
    }
    if (!p.website) {
      dropped.no_website++
      continue
    }
    if (!p.domain) {
      dropped.not_own_website++
      continue
    }
    const seen = byDomain.get(p.domain)
    if (!seen) {
      byDomain.set(p.domain, { ...p, domain: p.domain, branches: 1 })
      continue
    }
    dropped.duplicate_domain++
    const branches = seen.branches + 1
    byDomain.set(p.domain, score(p) > score(seen) ? { ...p, domain: p.domain, branches } : { ...seen, branches })
  }
  const kept = [...byDomain.values()].sort(
    (a, b) => Number(isPmCategory(b)) - Number(isPmCategory(a)) || (b.reviews ?? 0) - (a.reviews ?? 0) || a.name.localeCompare(b.name),
  )
  return { kept, dropped, total: items.length }
}

/** The sheet's columns, in order. `LinkedIn` and `PM Verdict` stay blank until the crawl worker runs. */
export const MAPS_SHEET_COLUMNS = [
  'Company',
  'Phone',
  'City',
  'State',
  'Zip',
  'Website',
  'Domain',
  'Rating',
  'Reviews',
  'Maps Category',
  'Maps PM',
  'Branches',
  'Address',
  'Google Maps',
  'Search',
  'Place ID',
] as const
export type MapsSheetColumn = (typeof MAPS_SHEET_COLUMNS)[number]

const cell = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v))

export function sheetCells(p: KeptPlace): Cells & Record<MapsSheetColumn, string> {
  return {
    Company: p.name,
    Phone: cell(p.phone),
    City: cell(p.city),
    State: cell(p.state),
    Zip: cell(p.postal_code),
    Website: cell(p.website),
    Domain: p.domain,
    Rating: cell(p.rating),
    Reviews: cell(p.reviews),
    'Maps Category': cell(p.category),
    'Maps PM': isPmCategory(p) ? 'yes' : 'no',
    Branches: cell(p.branches),
    Address: cell(p.address),
    'Google Maps': cell(p.maps_url),
    Search: cell(p.search),
    'Place ID': cell(p.place_id),
  }
}

/** The normalised lead item: the company is the "name", so lists dedupe on name + domain. */
export function sheetItem(p: KeptPlace): ListItem {
  return {
    name: p.name,
    company: p.name,
    first_name: null,
    last_name: null,
    title: null,
    website: p.website,
    domain: p.domain,
    category: p.category,
    city: p.city,
    state: p.state,
    country: p.country_code,
    phone: p.phone_e164 ?? p.phone,
    rating: p.rating,
    reviews_count: p.reviews,
    linkedin_url: null,
    email: null,
  }
}

/** A kept place as a lead-list row (source 'actor_run' or 'mcp'). */
export function sheetRow<S extends string>(p: KeptPlace, source: S): { raw: Raw; item: ListItem; cells: Cells; source: S } {
  return {
    raw: {
      companyname: p.name,
      website: p.website,
      domain: p.domain,
      phone: p.phone,
      phoneunformatted: p.phone_e164,
      address: p.address,
      street: p.street,
      city: p.city,
      state: p.state,
      postalcode: p.postal_code,
      countrycode: p.country_code,
      totalscore: p.rating,
      reviewscount: p.reviews,
      categoryname: p.category,
      categories: p.categories.join('; '),
      maps_pm: isPmCategory(p),
      branches: p.branches,
      placeid: p.place_id,
      url: p.maps_url,
      searchstring: p.search,
      lane: 'gtm-12-google-maps',
    },
    item: sheetItem(p),
    cells: sheetCells(p),
    source,
  }
}

/** The sheet as CSV (header + rows, CRLF); cells through csvCell (formula-like text neutralised, phones kept). */
export function sheetCsv(places: readonly KeptPlace[]): string {
  const lines = [MAPS_SHEET_COLUMNS.join(',')]
  for (const p of places) {
    const c = sheetCells(p)
    lines.push(MAPS_SHEET_COLUMNS.map((k) => csvCell(c[k])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

/** "412 companies kept of 1,980 places: 37 closed, 210 without a website, …" */
export function cleanSummary(r: CleanResult): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const parts: string[] = []
  if (r.dropped.permanently_closed) parts.push(`${n(r.dropped.permanently_closed)} permanently closed`)
  if (r.dropped.no_website) parts.push(`${n(r.dropped.no_website)} without a website`)
  if (r.dropped.not_own_website) parts.push(`${n(r.dropped.not_own_website)} with only a social or directory page`)
  if (r.dropped.duplicate_domain) parts.push(`${n(r.dropped.duplicate_domain)} duplicate listings of a kept company`)
  if (r.dropped.not_a_place) parts.push(`${n(r.dropped.not_a_place)} rows that were not places`)
  const pm = r.kept.filter(isPmCategory).length
  const head = `${n(r.kept.length)} companies kept of ${n(r.total)} places (${n(pm)} in Google's property management category)`
  return parts.length ? `${head}; dropped ${parts.join(', ')}.` : `${head}.`
}
