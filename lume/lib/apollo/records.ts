/**
 * Pure helpers for the Apollo enrichment path: normalise scraped rows (Apify
 * items, validation rows) into company/person records, build the CSV Apollo's
 * import expects, and estimate credits. No I/O here.
 */

export interface ApolloRecord {
  first_name: string | null
  last_name: string | null
  email: string | null
  title: string | null
  company: string | null
  domain: string | null
  website: string | null
  linkedin_url: string | null
  city: string | null
  state: string | null
  country: string | null
}

export type ApolloSource = { kind: 'dataset'; id: string } | { kind: 'run'; id: string } | { kind: 'job'; id: string }

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/** First non-empty value among keys, matched case- and separator-insensitively. */
function pick(row: Record<string, unknown>, keys: string[]): string | null {
  const index = new Map<string, unknown>()
  for (const [k, v] of Object.entries(row)) index.set(k.toLowerCase().replace(/[\s_.-]/g, ''), v)
  for (const k of keys) {
    const v = str(index.get(k))
    if (v) return v
  }
  return null
}

/** `https://www.Acme.com/about` → `acme.com`; null for social/maps links that aren't a company site. */
export function domainOf(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (s.includes('@') && !s.includes('/')) return s.split('@')[1]?.toLowerCase() || null
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    if (!host.includes('.')) return null
    if (/(^|\.)(google\.[a-z.]+|goo\.gl|facebook\.com|instagram\.com|linkedin\.com|yelp\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com)$/.test(host)) return null
    return host
  } catch {
    return null
  }
}

const GENERIC_EMAIL = /^(info|contact|hello|hi|sales|support|admin|office|team|help|enquiries|inquiries|service|booking|bookings)@/i

export function normaliseRecord(row: Record<string, unknown>): ApolloRecord {
  const full = pick(row, ['fullname', 'name', 'personname', 'contactname'])
  let first = pick(row, ['firstname', 'first', 'givenname'])
  let last = pick(row, ['lastname', 'last', 'surname', 'familyname'])
  const company = pick(row, ['companyname', 'company', 'organizationname', 'organization', 'businessname', 'title', 'placename', 'legalname'])
  // A row's "name" is a person only when there is also a separate company field.
  if (!first && !last && full && company && full !== company && full.split(/\s+/).length <= 4) {
    const parts = full.split(/\s+/)
    first = parts[0]
    last = parts.slice(1).join(' ') || null
  }
  const website = pick(row, ['website', 'websiteurl', 'companywebsite', 'url', 'site', 'domain', 'companydomain', 'web'])
  const email = pick(row, ['email', 'emailaddress', 'workemail', 'contactemail', 'emails'])
  const linkedin = pick(row, ['linkedinurl', 'linkedin', 'personlinkedinurl', 'linkedinprofile', 'profileurl'])
  return {
    first_name: first,
    last_name: last,
    email: email && /@/.test(email) ? email.split(/[,;\s]/)[0] : null,
    title: pick(row, ['jobtitle', 'position', 'role', 'persontitle']),
    company,
    domain: domainOf(website) ?? (email && !GENERIC_EMAIL.test(email) ? null : domainOf(email)),
    website,
    linkedin_url: linkedin && /linkedin\.com\//i.test(linkedin) ? linkedin : null,
    city: pick(row, ['city', 'locality', 'operatingcity']),
    state: pick(row, ['state', 'region', 'province']),
    country: pick(row, ['country', 'countrycode']),
  }
}

/** Columns Apollo's CSV import maps automatically. */
export const APOLLO_CSV_COLUMNS = [
  'First Name',
  'Last Name',
  'Email',
  'Title',
  'Company',
  'Website',
  'Company Domain',
  'Person Linkedin Url',
  'City',
  'State',
  'Country',
] as const

const cell = (v: string | null) => {
  const s = v ?? ''
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toApolloCsv(records: readonly ApolloRecord[]): string {
  const lines = [APOLLO_CSV_COLUMNS.join(',')]
  for (const r of records) {
    lines.push(
      [r.first_name, r.last_name, r.email, r.title, r.company, r.website, r.domain, r.linkedin_url, r.city, r.state, r.country].map(cell).join(',')
    )
  }
  return lines.join('\n') + '\n'
}

/** One record per company domain (first seen wins); rows without a domain are dropped. */
export function uniqueCompanies(records: readonly ApolloRecord[]): ApolloRecord[] {
  const seen = new Set<string>()
  const out: ApolloRecord[] = []
  for (const r of records) {
    if (!r.domain || seen.has(r.domain)) continue
    seen.add(r.domain)
    out.push(r)
  }
  return out
}

export interface Coverage {
  rows: number
  with_domain: number
  companies: number
  with_email: number
  with_personal_email: number
  with_linkedin: number
  with_person_name: number
}

export function coverage(records: readonly ApolloRecord[]): Coverage {
  return {
    rows: records.length,
    with_domain: records.filter((r) => r.domain).length,
    companies: uniqueCompanies(records).length,
    with_email: records.filter((r) => r.email).length,
    with_personal_email: records.filter((r) => r.email && !GENERIC_EMAIL.test(r.email)).length,
    with_linkedin: records.filter((r) => r.linkedin_url).length,
    with_person_name: records.filter((r) => r.first_name || r.last_name).length,
  }
}

/** Apollo charges 1 credit per person whose email/demographics come back (no phones requested); an upper bound. */
export function estimateCredits(companies: number, perCompany: number, maxPeople: number): number {
  return Math.min(companies * perCompany, maxPeople)
}

export const APOLLO_STEPS = [
  'Download the CSV from the link.',
  'In Apollo: Data Enrichment → CSV Enrichment (or People → Import → CSV) and upload the file.',
  'Map the columns (they are named the way Apollo expects), choose the decision-maker titles to find per company, and run the enrichment.',
  'Export the enriched contacts from Apollo as CSV.',
  'Drop that CSV into Lume Import (or Telegram); it waits at the usual Approve/Deny ingest gate, then goes through validation.',
]
