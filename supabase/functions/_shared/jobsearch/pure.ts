// Pure helpers for the job search pipeline. No I/O, no Deno APIs — everything
// here is unit-tested with `npx -y deno test supabase/functions/_shared/jobsearch/`.
// Shared by jobsearch-puller and jobsearch-sheet-writer.

// ---- Title filter ---------------------------------------------------------

export const GTM_TITLE_RE =
  /gtm engineer|go[- ]to[- ]market engineer|growth engineer|revenue engineer|gtm (ops|operations|systems|tooling|automation)|revops engineer|sales (systems|automation) engineer|forward deployed (gtm|growth)/i

export function isGtmTitle(title: string): boolean {
  return GTM_TITLE_RE.test(title ?? '')
}

// ---- Normalization --------------------------------------------------------

const CORPORATE_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'limited', 'corporation', 'incorporated', 'gmbh', 'plc'])

// lowercase, punctuation -> space, drop a leading "the" and trailing
// Inc/LLC/Ltd/Corp/Co, collapse whitespace. Only the ends are stripped so a
// name like "Co-Pilot" keeps its "co".
export function normalizeCompanyName(name: string): string {
  const toks = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
  while (toks.length > 1 && toks[0] === 'the') toks.shift()
  while (toks.length > 1 && CORPORATE_SUFFIXES.has(toks[toks.length - 1])) toks.pop()
  return toks.join(' ')
}

// strip scheme, www., path/query/fragment, lowercase.
export function normalizeDomain(input: string): string {
  let d = (input ?? '').trim().toLowerCase()
  if (!d) return ''
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  d = d.replace(/^www\./, '')
  d = d.split(/[/?#]/)[0]
  d = d.replace(/:\d+$/, '').replace(/\.+$/, '')
  return d
}

function squash(s: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// ---- Sheet header lookups (never hardcode a column index) -----------------

export function optionalHeaderIndex(headers: string[], name: string): number {
  const exact = headers.indexOf(name)
  if (exact !== -1) return exact
  const want = name.trim().toLowerCase()
  return headers.findIndex(h => (h ?? '').trim().toLowerCase() === want)
}

export function headerIndex(headers: string[], name: string): number {
  const i = optionalHeaderIndex(headers, name)
  if (i === -1) throw new Error(`Missing column "${name}" in sheet header (have: ${headers.join(', ')})`)
  return i
}

export function rowToRecord(headers: string[], row: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < headers.length; i++) out[headers[i]] = row[i] ?? ''
  return out
}

// ---- CSV ------------------------------------------------------------------

// State-machine parser: handles quoted commas, doubled quotes, CRLF and
// newlines inside quoted fields (Apollo exports have multi-line cells).
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text.charCodeAt(i)
    if (inQuotes) {
      if (c === 34 /* " */) {
        if (text.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += text[i]; i++; continue
    }
    if (c === 34) { inQuotes = true; i++; continue }
    if (c === 44 /* , */) { row.push(field); field = ''; i++; continue }
    if (c === 13 /* \r */) { i++; continue }
    if (c === 10 /* \n */) {
      row.push(field); field = ''
      if (!(row.length === 1 && row[0] === '')) records.push(row)
      row = []; i++; continue
    }
    field += text[i]; i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) records.push(row)
  }
  if (records.length === 0) return { headers: [], rows: [] }
  return { headers: records[0], rows: records.slice(1) }
}

export function parseCsvRow(row: string): string[] {
  return parseCsv(row + '\n').headers
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')]
  for (const r of rows) lines.push(r.map(csvEscape).join(','))
  return lines.join('\r\n') + '\r\n'
}

// ---- Roles and ranking ----------------------------------------------------

export type Role = 'job_poster' | 'recruiter' | 'sales_leader' | 'founder' | 'other'

export const ROLE_PRIORITY: Record<Role, number> = {
  job_poster: 0,
  recruiter: 1,
  sales_leader: 2,
  founder: 3,
  other: 4,
}

const RECRUITER_RE = /recruit|talent|people ops|head of people|hiring/i
const SALES_LEADER_RE =
  /\bcro\b|chief revenue|head of (sales|gtm|growth|revenue)|\bvp,? (of )?(sales|gtm|revenue|growth)|revops|revenue operations|sales director|director of sales|gtm lead|sales lead/i
const FOUNDER_RE = /founder|\bceo\b|chief executive/i

export function assignRole(
  title: string | null | undefined,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  jobPosterName: string | null | undefined,
): Role {
  const poster = squash(jobPosterName ?? '')
  if (poster) {
    const full = squash(`${firstName ?? ''} ${lastName ?? ''}`)
    if (full && full === poster) return 'job_poster'
    const first = squash(firstName ?? '')
    const last = squash(lastName ?? '')
    if (first && last && poster.includes(first) && poster.includes(last)) return 'job_poster'
  }
  const t = title ?? ''
  if (RECRUITER_RE.test(t)) return 'recruiter'
  if (SALES_LEADER_RE.test(t)) return 'sales_leader'
  if (FOUNDER_RE.test(t)) return 'founder'
  return 'other'
}

// Apollo seniority labels, most senior first. Unknown -> last.
export const SENIORITY_PRIORITY: Record<string, number> = {
  owner: 0, founder: 1, c_suite: 2, partner: 3, vp: 4, head: 5, director: 6, manager: 7, senior: 8, entry: 9, intern: 10,
}

export function seniorityRank(seniority: string | null | undefined): number {
  const key = (seniority ?? '').toLowerCase().trim().replace(/[^a-z]+/g, '_')
  return key in SENIORITY_PRIORITY ? SENIORITY_PRIORITY[key] : 99
}

export interface Rankable {
  role: Role
  email: string | null
  seniority: string | null
}

// Within one company: role priority, then has-email first, then seniority.
// Stable, so ties keep CSV order. kept = rank <= keepTop.
export function rankContacts<T extends Rankable>(contacts: T[], keepTop = 5): (T & { rank: number; kept: boolean })[] {
  const indexed = contacts.map((c, i) => ({ c, i }))
  indexed.sort((a, b) => {
    const r = ROLE_PRIORITY[a.c.role] - ROLE_PRIORITY[b.c.role]
    if (r !== 0) return r
    const e = Number(!a.c.email) - Number(!b.c.email)
    if (e !== 0) return e
    const s = seniorityRank(a.c.seniority) - seniorityRank(b.c.seniority)
    if (s !== 0) return s
    return a.i - b.i
  })
  return indexed.map(({ c }, idx) => ({ ...c, rank: idx + 1, kept: idx + 1 <= keepTop }))
}

// ---- Apollo people-search URL ---------------------------------------------

export const APOLLO_MAX_ORGS = 60

const APOLLO_SENIORITIES = ['owner', 'founder', 'c_suite', 'vp', 'head', 'director', 'manager']
const APOLLO_DEPARTMENTS = ['c_suite', 'master_sales', 'master_human_resources', 'master_operations']

// Verified by hand on 2026-10-09: three companies -> 39 people, the right mix
// of founders, CRO/sales leaders and the recruiting lead.
export function buildApolloUrl(orgIds: string[]): string {
  if (orgIds.length === 0) throw new Error('buildApolloUrl: no organization ids')
  if (orgIds.length > APOLLO_MAX_ORGS) throw new Error(`buildApolloUrl: ${orgIds.length} ids exceeds the ${APOLLO_MAX_ORGS} cap`)
  const parts = ['sortAscending=false', 'sortByField=%5Bnone%5D', 'page=1']
  for (const id of orgIds) parts.push(`organizationIds%5B%5D=${encodeURIComponent(id)}`)
  for (const s of APOLLO_SENIORITIES) parts.push(`personSeniorities%5B%5D=${s}`)
  for (const d of APOLLO_DEPARTMENTS) parts.push(`personDepartmentOrSubdepartments%5B%5D=${d}`)
  return `https://app.apollo.io/#/people?${parts.join('&')}`
}

// ---- Leadsfriday CSV -> job_contacts --------------------------------------

export interface ContactFields {
  first_name: string | null
  last_name: string | null
  title: string | null
  email: string | null
  linkedin_url: string | null
  company_name: string
  website: string | null
  seniority: string | null
  department: string | null
  location: string | null
  corporate_phone: string | null
}

// Candidate header names per field, matched after lowercasing and collapsing
// spaces/underscores. Apollo-style export names first, snake_case after.
// TODO(first run): confirm against the real Leadsfriday header and prune.
export const LEADSFRIDAY_COLUMNS: Record<Exclude<keyof ContactFields, 'location'>, string[]> = {
  first_name: ['first name', 'firstname', 'given name'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  title: ['title', 'job title', 'position', 'headline'],
  email: ['email', 'work email', 'email address', 'business email'],
  linkedin_url: ['person linkedin url', 'linkedin url', 'linkedin', 'linkedin profile', 'profile url'],
  company_name: ['company', 'company name', 'company name for emails', 'organization', 'organization name', 'account name'],
  website: ['website', 'company website', 'organization website', 'domain', 'company domain'],
  seniority: ['seniority', 'seniority level'],
  department: ['departments', 'department'],
  corporate_phone: ['corporate phone', 'company phone', 'organization phone', 'phone', 'work phone'],
}

const LOCATION_COLUMNS = {
  whole: ['location', 'person location'],
  city: ['city', 'person city'],
  state: ['state', 'person state'],
  country: ['country', 'person country'],
}

function normKey(k: string): string {
  return k.toLowerCase().replace(/[_\s]+/g, ' ').trim()
}

function pick(rec: Record<string, string>, candidates: string[]): string | null {
  for (const c of candidates) {
    const v = rec[c]
    if (v !== undefined && v.trim() !== '') return v.trim()
  }
  return null
}

export function mapLeadsfridayRow(record: Record<string, string>): ContactFields {
  const rec: Record<string, string> = {}
  for (const [k, v] of Object.entries(record)) rec[normKey(k)] = v ?? ''

  const location = pick(rec, LOCATION_COLUMNS.whole) ??
    ([pick(rec, LOCATION_COLUMNS.city), pick(rec, LOCATION_COLUMNS.state), pick(rec, LOCATION_COLUMNS.country)]
      .filter(Boolean).join(', ') || null)

  return {
    first_name: pick(rec, LEADSFRIDAY_COLUMNS.first_name),
    last_name: pick(rec, LEADSFRIDAY_COLUMNS.last_name),
    title: pick(rec, LEADSFRIDAY_COLUMNS.title),
    email: pick(rec, LEADSFRIDAY_COLUMNS.email)?.toLowerCase() ?? null,
    linkedin_url: pick(rec, LEADSFRIDAY_COLUMNS.linkedin_url),
    company_name: pick(rec, LEADSFRIDAY_COLUMNS.company_name) ?? '',
    website: pick(rec, LEADSFRIDAY_COLUMNS.website),
    seniority: pick(rec, LEADSFRIDAY_COLUMNS.seniority),
    department: pick(rec, LEADSFRIDAY_COLUMNS.department),
    location,
    corporate_phone: pick(rec, LEADSFRIDAY_COLUMNS.corporate_phone),
  }
}
