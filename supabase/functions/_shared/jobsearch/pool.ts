// The eligible pool: which Jobs Final rows a batch may draw from, in what
// order. Pure — the puller and jobsearch-notify both call this on a grid they
// have already read.
//
// Tiers (lower is better, taken first):
//   1  strict GTM-engineer titles (GTM_TITLE_RE)
//   2  GTM-adjacent: founding AE/BDR, RevOps, GTM ops/strategy, sales/solutions
//      engineer, growth, bizops, partnerships, SDR/BDR …
//   3  everything else that is not excluded (plain AEs and the like)
//
// Excluded regardless of tier: status "Not a Right Fit", already in gtm,
// already taken by another live batch, or outside the lookback window.

import { headerIndex, isGtmTitle, normalizeCompanyName, normalizeDomain, optionalHeaderIndex, rowToRecord, sameSheetDate } from './pure.ts'

export const ADJACENT_TITLE_RE =
  /founding (ae|account|sales|gtm|growth|bdr|sdr|business development|biz ?ops|strategy|commercial|forward deployed|product deployment|customer)|sales engineer|solutions? (engineer|architect|consultant)|forward deployed|deployment (specialist|strateg)|rev ?ops|revenue operations|sales operations|sales ops|\bgtm\b|go[- ]to[- ]market|\bgrowth\b|business operations|biz ?ops|strategy (&|and) operations|strategy & ops|sales (strategy|enablement|systems|finance|development)|demand gen|marketing ops|product marketing|partnership|business development|\b(sdr|bdr)\b|account manager|customer success|revenue enablement|enablement/i

export type Tier = 1 | 2 | 3

export function titleTier(title: string | null | undefined): Tier {
  const t = title ?? ''
  if (isGtmTitle(t)) return 1
  if (ADJACENT_TITLE_RE.test(t)) return 2
  return 3
}

// ISO date for a sheet cell: "2026-09-17", "2026-09-17T…", a Sheets serial, or
// a relative string like "21 days ago" / "about 2 months ago" (also the
// truncated "21 days ag" that a narrow column exports). null when unparseable.
export function parseSheetDate(cell: string | number | null | undefined, today: string): string | null {
  if (cell === null || cell === undefined) return null
  const s = String(cell).trim()
  if (!s) return null
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s)
    if (serial > 20000 && serial < 80000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10)
    }
    return null
  }
  // Relative strings, including ones a narrow column truncated ("21 days ag",
  // "about 1 ye"): a count (or "a"/"an") then a unit's first letter.
  const rel = s.match(/(?:about |over |almost )?(\d+|an?)\s+([dwmy])[a-z]*/i)
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : 1
    const unit = rel[2].toLowerCase()
    const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365
    const base = new Date(`${today}T12:00:00Z`).getTime()
    return new Date(base - days * 86_400_000).toISOString().slice(0, 10)
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(`${toIso}T12:00:00Z`).getTime() - new Date(`${fromIso}T12:00:00Z`).getTime()) / 86_400_000)
}

// A row is inside the window when EITHER its added_on or its postedAt falls
// within lookbackDays of batchDate. Rows with neither date are kept: the
// owner asked for everything, and an undated row is not evidence of age.
export function withinLookback(
  postedAt: string | null | undefined,
  addedOn: string | null | undefined,
  batchDate: string,
  lookbackDays: number,
): boolean {
  const dates = [parseSheetDate(postedAt ?? null, batchDate), parseSheetDate(addedOn ?? null, batchDate)].filter(Boolean) as string[]
  if (dates.length === 0) return true
  return dates.some(d => {
    const age = daysBetween(d, batchDate)
    return age <= lookbackDays && age >= -7 // a few days in the future is a timezone artefact, not the future
  })
}

export interface PoolRow {
  sheetRow: number                 // 1-based row number in the tab, for debugging
  record: Record<string, string>   // the full Jobs Final row by header
  company_name: string
  website: string | null
  domain: string | null
  norm_name: string
  title: string
  tier: Tier
  posted_at: string | null         // ISO when parseable
  added_on: string | null
  exclude: 'not_a_right_fit' | 'already_in_gtm' | 'already_taken' | 'outside_lookback' | null
  is_new: boolean                  // added_on == batchDate (this scrape's rows)
}

export interface PoolOptions {
  batchDate: string
  lookbackDays: number
  gtmNames: Set<string>
  gtmDomains: Set<string>
  takenDomains: Set<string>        // companies already in another live batch (or this one)
  takenNames: Set<string>
}

export interface Pool {
  eligible: PoolRow[]              // deduped, sorted tier asc then posted_at desc then sheet order
  excluded: PoolRow[]
  byTier: Record<Tier, number>
  newRows: number                  // rows with added_on == batchDate
}

export function classifyPool(headers: string[], rows: string[][], opts: PoolOptions): Pool {
  const col = {
    company: headerIndex(headers, 'companyName'),
    title: headerIndex(headers, 'title'),
    status: headerIndex(headers, 'status'),
    website: headerIndex(headers, 'companyWebsite'),
    addedOn: optionalHeaderIndex(headers, 'added_on'),
    postedAt: optionalHeaderIndex(headers, 'postedAt'),
  }

  const seen = new Map<string, PoolRow>()
  const excluded: PoolRow[] = []
  let newRows = 0

  rows.forEach((row, i) => {
    const name = (row[col.company] ?? '').trim()
    if (!name) return
    const website = (row[col.website] ?? '').trim() || null
    const domain = website ? normalizeDomain(website) || null : null
    const norm = normalizeCompanyName(name)
    const title = (row[col.title] ?? '').trim()
    const status = (row[col.status] ?? '').trim().toLowerCase()
    const addedOnRaw = col.addedOn >= 0 ? row[col.addedOn] ?? '' : ''
    const postedRaw = col.postedAt >= 0 ? row[col.postedAt] ?? '' : ''
    const isNew = sameSheetDate(addedOnRaw, opts.batchDate)
    if (isNew) newRows++

    let exclude: PoolRow['exclude'] = null
    if (status === 'not a right fit') exclude = 'not_a_right_fit'
    else if ((domain && opts.gtmDomains.has(domain)) || (norm && opts.gtmNames.has(norm))) exclude = 'already_in_gtm'
    else if ((domain && opts.takenDomains.has(domain)) || (norm && opts.takenNames.has(norm))) exclude = 'already_taken'
    else if (!withinLookback(postedRaw, addedOnRaw, opts.batchDate, opts.lookbackDays)) exclude = 'outside_lookback'

    const pr: PoolRow = {
      sheetRow: i + 2,
      record: rowToRecord(headers, row),
      company_name: name,
      website,
      domain,
      norm_name: norm,
      title,
      tier: titleTier(title),
      posted_at: parseSheetDate(postedRaw, opts.batchDate),
      added_on: parseSheetDate(addedOnRaw, opts.batchDate),
      exclude,
      is_new: isNew,
    }
    if (exclude) { excluded.push(pr); return }

    // One row per company: keep the better tier, then the newer posting.
    const key = domain ?? `name:${norm}`
    const prev = seen.get(key)
    if (!prev || pr.tier < prev.tier || (pr.tier === prev.tier && (pr.posted_at ?? '') > (prev.posted_at ?? ''))) {
      seen.set(key, pr)
    }
  })

  const eligible = Array.from(seen.values()).sort((a, b) =>
    a.tier - b.tier ||
    (b.posted_at ?? '').localeCompare(a.posted_at ?? '') ||
    a.sheetRow - b.sheetRow,
  )
  const byTier: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 }
  for (const r of eligible) byTier[r.tier]++
  return { eligible, excluded, byTier, newRows }
}

// ---- Order sizing ---------------------------------------------------------

export const LEADSFRIDAY_MIN_CONTACTS = 500
export const CONTACTS_PER_COMPANY = 15
export const MAX_COMPANIES_PER_ORDER = 60     // Apollo URL cap
export const FILL_CUSHION = 1.25               // over-take to absorb Apollo misses

// Resolved companies needed before an order is worth placing.
export function companiesNeeded(min = LEADSFRIDAY_MIN_CONTACTS, per = CONTACTS_PER_COMPANY): number {
  return Math.ceil(min / per)
}

// How many more companies to pull into the batch this round, given what is
// already resolved or still pending. Never exceeds the Apollo cap.
export function companiesToTake(resolved: number, pending: number): number {
  const shortfall = companiesNeeded() - resolved - pending
  if (shortfall <= 0) return 0
  const want = Math.ceil(shortfall * FILL_CUSHION)
  return Math.max(0, Math.min(want, MAX_COMPANIES_PER_ORDER - resolved - pending))
}

export function contactCountFor(resolved: number): number {
  return Math.max(LEADSFRIDAY_MIN_CONTACTS, resolved * CONTACTS_PER_COMPANY)
}
