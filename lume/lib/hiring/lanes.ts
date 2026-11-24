import type { Lane } from '@/lib/hiring/config'
import { classifyRole, cleanLinkedIn, cleanUrl, companyDomain, countryOf, normCompany, type RoleTier } from '@/lib/hiring/normalize'

/**
 * GTM-19: the three lanes' Apify actors, input builders and normalisers (pure).
 *
 *  hiring       curious_coder/linkedin-jobs-scraper (no cookies, pay per
 *               result). Its items carry jobPosterName / jobPosterTitle /
 *               jobPosterProfileUrl (the person who posted the ad, when
 *               LinkedIn shows one), companyWebsite and companyLinkedinUrl
 *               (with scrapeCompany, no extra charge). One search URL per
 *               title group (leadership / coordinator) x region, past 24 h.
 *  new_manager  harvestapi/linkedin-profile-search (no cookies): people with
 *               an ops-leader title who changed jobs recently, at real-estate
 *               companies of 11-1,000 staff in the US / Canada; kept only when
 *               the current position started <= 90 days ago.
 *  expansion    lhotanova/google-news-scraper: PM company acquisitions,
 *               funding and expansion news from the last day, one run per
 *               edition (US:en, CA:en). Each article goes through a Haiku
 *               extraction (lib/hiring/extract.ts) before it becomes a row.
 */

export const ACTORS: Record<Lane, string> = {
  hiring: 'curious_coder/linkedin-jobs-scraper',
  new_manager: 'harvestapi/linkedin-profile-search',
  expansion: 'lhotanova/google-news-scraper',
}

/** Run timeouts (seconds) Apify enforces. */
export const RUN_TIMEOUT_S: Record<Lane, number> = { hiring: 900, new_manager: 900, expansion: 600 }

export interface Candidate {
  dedupe_key: string
  signal: Lane
  role_tier: RoleTier | null
  role_title: string | null
  headline: string | null
  source_url: string | null
  posted_at: string | null
  location: string | null
  country: 'US' | 'CA' | null
  company_name: string | null
  company_domain: string | null
  company_website: string | null
  company_phone: string | null
  company_linkedin: string | null
  person_name: string | null
  person_title: string | null
  person_linkedin: string | null
  raw: Record<string, unknown>
}

export interface LaneInput {
  /** Distinguishes several runs of one lane per tick (expansion's editions). */
  variant: string
  input: Record<string, unknown>
  maxItems: number
}

type Raw = Record<string, unknown>
const str = (v: unknown, n = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null)
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null)

function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

const base = (signal: Lane, dedupe_key: string, raw: Raw): Candidate => ({
  dedupe_key,
  signal,
  role_tier: null,
  role_title: null,
  headline: null,
  source_url: null,
  posted_at: null,
  location: null,
  country: null,
  company_name: null,
  company_domain: null,
  company_website: null,
  company_phone: null,
  company_linkedin: null,
  person_name: null,
  person_title: null,
  person_linkedin: null,
  raw,
})

// ── hiring ─────────────────────────────────────────────────────────────────

export const LEADERSHIP_TITLES = [
  'COO',
  'VP of Operations',
  'Director of Operations',
  'Head of Operations',
  'Director of Property Management',
  'Regional Property Manager',
  'Portfolio Manager',
  'Property Manager',
] as const
export const COORDINATOR_TITLES = [
  'Maintenance Coordinator',
  'Leasing Coordinator',
  'Leasing Agent',
  'Leasing Consultant',
  'Assistant Property Manager',
  'Office Administrator',
  'Resident Services Coordinator',
] as const

const orGroup = (titles: readonly string[]) => titles.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' OR ')
export const HIRING_QUERIES: Record<RoleTier, string> = {
  leadership: `"property management" (${orGroup(LEADERSHIP_TITLES)})`,
  coordinator: `"property management" (${orGroup(COORDINATOR_TITLES)})`,
}

export const HIRING_PER_SEARCH = 50

/** A public LinkedIn jobs search URL: keywords + location, posted in the past 24 h. */
export function jobsSearchUrl(keywords: string, location: string): string {
  const q = new URLSearchParams({ keywords, location, f_TPR: 'r86400' })
  return `https://www.linkedin.com/jobs/search/?${q}`
}

/** One run: 2 title groups x the regions, `perSearch` jobs each. */
export function buildHiringInput(regions: readonly string[], maxItems?: number): LaneInput {
  const urls = (['leadership', 'coordinator'] as const).flatMap((tier) => regions.map((r) => jobsSearchUrl(HIRING_QUERIES[tier], r)))
  const total = maxItems && maxItems > 0 ? Math.floor(maxItems) : HIRING_PER_SEARCH * urls.length
  const perSearch = Math.max(1, Math.ceil(total / urls.length))
  return {
    variant: 'default',
    input: { urls, scrapeCompany: true, limitPerSource: perSearch, autoConvertToAiSearch: true },
    maxItems: total,
  }
}

/** A curious_coder job item → candidate; null when it is not a leadership / coordinator role or not in the US / Canada. */
export function normalizeJob(item: Raw): Candidate | null {
  const id = str(item.id, 40) ?? (typeof item.id === 'number' ? String(item.id) : null)
  const title = str(item.title, 200)
  if (!id || !title) return null
  const tier = classifyRole(title)
  if (!tier) return null
  const location = str(item.location, 200)
  const country = countryOf(location)
  if (location && !country && /,/.test(location)) return null // a located job outside the US / Canada
  const website = cleanUrl(str(item.companyWebsite, 500))
  const link = cleanUrl(str(item.link, 1000))
  const c = base('hiring', `job:${id}`, pickRaw(item, ['id', 'title', 'companyName', 'location', 'postedAt', 'jobPosterName', 'jobPosterTitle', 'jobPosterProfileUrl', 'companyWebsite', 'companyLinkedinUrl', 'seniorityLevel', 'employmentType', 'industries', 'companyEmployeesCount']))
  return {
    ...c,
    role_tier: tier,
    role_title: title,
    headline: str(item.jobPosterTitle, 200),
    source_url: link ? link.replace(/\?.*$/, '') : `https://www.linkedin.com/jobs/view/${id}`,
    posted_at: iso(item.postedAtTimestamp) ?? iso(item.postedAt),
    location,
    country,
    company_name: str(item.companyName, 200),
    company_domain: companyDomain(website),
    company_website: website,
    company_linkedin: cleanLinkedIn(str(item.companyLinkedinUrl, 500)),
    person_name: str(item.jobPosterName, 120),
    person_title: str(item.jobPosterTitle, 200),
    person_linkedin: cleanLinkedIn(str(item.jobPosterProfileUrl, 500)),
  }
}

function pickRaw(item: Raw, keys: string[]): Raw {
  const out: Raw = {}
  for (const k of keys) if (item[k] !== undefined && item[k] !== null) out[k] = typeof item[k] === 'string' ? (item[k] as string).slice(0, 500) : item[k]
  return out
}

// ── new_manager ────────────────────────────────────────────────────────────

export const OPS_LEADER_TITLES = [
  'COO',
  'Chief Operating Officer',
  'VP of Operations',
  'Director of Operations',
  'Head of Operations',
  'Director of Property Management',
  'Regional Property Manager',
  'Regional Manager',
  'Portfolio Manager',
] as const
/** LinkedIn industry ids: 44 Real Estate, 1759 Leasing Residential Real Estate, 128 Leasing Non-residential Real Estate. */
export const PM_INDUSTRY_IDS = ['44', '1759', '128'] as const
/** Company headcount 11-50 … 1,001-5,000. */
export const PM_HEADCOUNT = ['C', 'D', 'E', 'F', 'G'] as const
export const NEW_MANAGER_MAX_ITEMS = 50
export const NEW_MANAGER_DAYS = 90

export function buildNewManagerInput(regions: readonly string[], maxItems?: number): LaneInput {
  const n = maxItems && maxItems > 0 ? Math.floor(maxItems) : NEW_MANAGER_MAX_ITEMS
  return {
    variant: 'default',
    input: {
      currentJobTitles: [...OPS_LEADER_TITLES],
      recentlyChangedJobs: true,
      industryIds: [...PM_INDUSTRY_IDS],
      companyHeadcount: [...PM_HEADCOUNT],
      locations: [...regions],
      profileScraperMode: 'Full',
      maxItems: n,
    },
    maxItems: n,
  }
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** The first day of a {month, year} (month as 1-12 or "Jan"); null when the year is missing. */
export function startOf(d: unknown): Date | null {
  const o = obj(d)
  if (!o) return null
  const year = typeof o.year === 'number' ? o.year : Number(o.year)
  if (!Number.isInteger(year) || year < 1950) return null
  const m = typeof o.month === 'number' ? o.month : typeof o.month === 'string' ? (MONTHS[o.month.slice(0, 3).toLowerCase()] ?? Number(o.month)) : 1
  const month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : 1
  return new Date(Date.UTC(year, month - 1, 1))
}

/**
 * A harvestapi profile → candidate when its current position is an
 * ops-leader role that started within the last 90 days (month precision: a
 * start month counts when it overlaps the window).
 */
export function normalizePerson(item: Raw, now: Date): Candidate | null {
  const url = cleanLinkedIn(str(item.linkedinUrl, 500))
  if (!url) return null
  const exp = Array.isArray(item.experience) ? item.experience.map(obj).filter((x): x is Raw => !!x) : []
  const current = exp.find((e) => !obj(e.endDate)?.year && /present/i.test(String(obj(e.endDate)?.text ?? 'present'))) ?? exp[0]
  const pos = Array.isArray(item.currentPosition) ? obj(item.currentPosition[0]) : null
  const title = str(current?.position, 200) ?? str(item.headline, 200)
  const tier = classifyRole(title)
  if (tier !== 'leadership') return null
  const started = startOf(current?.startDate) ?? startOf(obj(obj(pos?.dateRange)?.start))
  if (!started) return null
  const windowStart = new Date(now.getTime() - NEW_MANAGER_DAYS * 86_400_000)
  const monthEnd = new Date(Date.UTC(started.getUTCFullYear(), started.getUTCMonth() + 1, 1))
  if (monthEnd <= windowStart || started > now) return null
  const loc = obj(item.location)
  const parsed = obj(loc?.parsed)
  const location = str(parsed?.text, 200) ?? str(loc?.linkedinText, 200)
  const country = countryOf(location, str(parsed?.countryCode, 4) ?? str(loc?.countryCode, 4))
  if (!country) return null
  const name = [str(item.firstName, 60), str(item.lastName, 60)].filter(Boolean).join(' ') || null
  const c = base('new_manager', `person:${url.toLowerCase()}`, { ...pickRaw(item, ['publicIdentifier', 'headline']), started: started.toISOString().slice(0, 7) })
  return {
    ...c,
    role_tier: tier,
    role_title: title,
    headline: str(item.headline, 200),
    source_url: url,
    posted_at: started.toISOString(),
    location,
    country,
    company_name: str(current?.companyName, 200) ?? str(pos?.companyName, 200),
    company_linkedin: cleanLinkedIn(str(current?.companyLinkedinUrl, 500) ?? str(pos?.companyLinkedinUrl, 500)),
    person_name: name,
    person_title: title,
    person_linkedin: url,
  }
}

// ── expansion ──────────────────────────────────────────────────────────────

export const EXPANSION_QUERY =
  '"property management" (acquires OR acquired OR acquisition OR "raises" OR funding OR expands OR expansion OR "new market") -jobs -hiring'
export const EXPANSION_EDITIONS: Record<string, string> = { 'United States': 'US:en', Canada: 'CA:en' }
export const EXPANSION_MAX_ITEMS = 40

export function buildExpansionInputs(regions: readonly string[], maxItems?: number): LaneInput[] {
  const n = maxItems && maxItems > 0 ? Math.floor(maxItems) : EXPANSION_MAX_ITEMS
  return regions
    .filter((r) => EXPANSION_EDITIONS[r])
    .map((r) => ({
      variant: EXPANSION_EDITIONS[r],
      input: { query: EXPANSION_QUERY, language: EXPANSION_EDITIONS[r], openEndedDateRange: '1d', maxItems: n, fetchArticleDetails: true, fetchArticlePage: false },
      maxItems: n,
    }))
}

export interface Article {
  url: string
  title: string
  source: string | null
  published_at: string | null
  edition: string
}

/** A Google News item → article (the publisher URL when resolved, else the news link). */
export function normalizeArticle(item: Raw, edition: string): Article | null {
  const url = cleanUrl(str(item.loadedUrl, 1000)) ?? cleanUrl(str(item.link, 1000))
  const title = str(item.title, 300)
  if (!url || !title) return null
  return { url: url.replace(/[?#].*$/, ''), title, source: str(item.source, 120), published_at: iso(item.publishedAt), edition }
}

export interface Extraction {
  relevant: boolean
  company_name: string
  domain: string
  event_type: 'acquisition' | 'acquired' | 'funding' | 'expansion' | 'other'
  summary: string
}

/** An article + its extraction → candidate; null when it is not a PM company event. */
export function articleCandidate(a: Article, x: Extraction): Candidate | null {
  if (!x.relevant || x.event_type === 'other') return null
  const name = str(x.company_name, 200)
  const key = normCompany(name)
  if (!name || !key) return null
  const domain = companyDomain(x.domain)
  const c = base('expansion', `news:${a.url}|${key}`, { title: a.title, source: a.source, edition: a.edition, event_type: x.event_type })
  return {
    ...c,
    role_title: x.event_type,
    headline: str(x.summary, 300) ?? a.title,
    source_url: a.url,
    posted_at: a.published_at,
    country: a.edition === 'CA:en' ? 'CA' : a.edition === 'US:en' ? 'US' : null,
    company_name: name,
    company_domain: domain,
    company_website: domain ? `https://${domain}` : null,
  }
}

/** Dedupe within one batch by key (first wins). */
export function uniqueByKey(cs: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  return cs.filter((c) => !seen.has(c.dedupe_key) && !!seen.add(c.dedupe_key))
}
