/**
 * PM influencer reactions → Apollo CSV (Lume built-in skill). Pure and
 * client-safe: the last full run's benchmarks, the per-influencer and per-run
 * cost estimate, and the Apollo contact-import CSV. Storage lives in
 * `lib/influencers/store.ts`; the pipeline itself is the `influencer-reactions`
 * edge function (supabase/functions/influencer-reactions).
 */
import { domainOf } from '@/lib/apollo/records'

export interface InfluencerRow {
  id: string
  name: string
  slug: string
  linkedin_url: string
  lookback_days: number
  max_reactions_per_post: number
  active: boolean
  notes: string | null
  last_ran_at: string | null
  last_posts: number | null
  last_top_posts: number | null
  last_reactions: number | null
  last_reactors: number | null
  last_leads: number | null
  last_leads_700: number | null
  last_apify_usd: number | string | null
  last_perplexity_usd: number | string | null
  last_haiku_usd: number | string | null
  last_cost_usd: number | string | null
}

// ---------------------------------------------------------------------------
// prices and the last full run

/** Unit prices (verified 2026-10-06; same as supabase/functions/_shared/influencer/cost.ts). */
export const PRICES = {
  posts_per_1k: 2,
  reactions_per_1k: 1.5,
  perplexity_per_call: 0.006,
  /** Haiku 5.5 is a tenth of Haiku 4.5's price; the old run's ~$3 Haiku over 7,638 reactors is ~$0.0004 each at 4.5 prices. */
  haiku_per_reactor: 0.00004,
} as const

export const TOP_POSTS = 10
export const APIFY_RUN_MAX_USD = 20
export const MONTHLY_APIFY_CAP_USD = 29

/** The 2026-10-08 full run (all 26 influencers), from ~/docs/plans/2026-10-06-pm-reactions-pipeline-design.md. */
export const LAST_RUN = {
  date: '2026-10-08',
  influencers: 26,
  with_posts: 21,
  total_usd: 37,
  apify_usd: 25,
  perplexity_usd: 9,
  haiku_usd: 3,
  reactions: 13032,
  unique_reactors: 7638,
  candidates: 1957,
  verified: 254,
  with_door_count: 218,
  leads_700: 97,
  /** ~1 verified lead per 30 unique reactors. */
  reactors_per_lead: Math.round(7638 / 254),
  /** ~38% of verified leads at 700+ doors. */
  pct_700_of_verified: Math.round((97 / 254) * 100),
  candidate_rate: 1957 / 7638,
  reactors_per_reaction: 7638 / 13032,
  /** Perplexity spend per triage candidate, door retries included ($8.92 / 1,957). */
  perplexity_per_candidate: 8.92 / 1957,
  avg_reactions_per_influencer: Math.round(13032 / 21),
  best: ['Peter Lohmann (71 leads, 26 at 700+)', 'Jay Parsons (39, 24 at 700+)', 'Deb Newell (25)', 'Brad Johnson (24)'],
  zero_yield: [
    'Barbara Savona, DD Garzon, Kristin Anikewich (no posts)',
    'Angela Holman, David Rintz (no PM posts)',
    'Mike Brewer (vendor audience)',
  ],
} as const

const ceilCents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100
const cents = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Apify posts reservation = maxTotalChargeUsd of the posts run (edge function parity). */
export function postsReserveUsd(lastPosts: number | null | undefined): number {
  const posts = (lastPosts === null || lastPosts === undefined ? 300 : Math.max(0, lastPosts)) * 1.5
  return Math.min(APIFY_RUN_MAX_USD, ceilCents((posts * PRICES.posts_per_1k) / 1000 + 0.1))
}

/** Apify reactions maxTotalChargeUsd for an exact bill (edge function parity). */
export function reactionsMaxChargeUsd(estimateUsd: number): number {
  return Math.min(APIFY_RUN_MAX_USD, ceilCents(Math.max(0, estimateUsd) * 1.1 + 0.05))
}

// ---------------------------------------------------------------------------
// estimates

export interface Range { low: number; high: number }
export interface Range3 extends Range { expected: number }

export interface InfluencerEstimate {
  slug: string
  name: string
  basis: 'last_run' | 'benchmark'
  last_ran_at: string | null
  posts: number
  posts_usd: number
  posts_reserve_usd: number
  reactions: Range3
  reactions_usd: Range3
  new_reactors: Range
  perplexity_usd: Range
  haiku_usd: number
  leads_per_reactor: number
  leads: Range
  leads_700: Range
  last_cost_usd: number | null
  last_leads: number | null
  last_leads_700: number | null
  zero_yield: boolean
  warning: string | null
}

/** Share of a re-run influencer's reactors that are new (not verified / rejected / triaged before): 30% to 100%. */
const RERUN_NEW_LOW = 0.3

export function estimateInfluencer(inf: InfluencerRow): InfluencerEstimate {
  const ran = !!inf.last_ran_at && inf.last_reactions !== null
  const capMax = TOP_POSTS * inf.max_reactions_per_post
  const posts = inf.last_posts ?? 300
  let reactions: Range3
  if (!ran) {
    const exp = Math.min(capMax, LAST_RUN.avg_reactions_per_influencer)
    reactions = { low: 0, expected: exp, high: Math.min(capMax, exp * 3) }
  } else if ((inf.last_reactions ?? 0) === 0) {
    reactions = { low: 0, expected: 0, high: Math.min(capMax, LAST_RUN.avg_reactions_per_influencer) }
  } else {
    const r = inf.last_reactions!
    reactions = { low: Math.round(r * 0.7), expected: r, high: Math.min(capMax, Math.round(r * 1.3)) }
  }
  const usd = (n: number) => (n * PRICES.reactions_per_1k) / 1000
  const reactors = ran && inf.last_reactors !== null ? inf.last_reactors : Math.round(reactions.expected * LAST_RUN.reactors_per_reaction)
  const newReactors: Range = ran ? { low: Math.round(reactors * RERUN_NEW_LOW), high: reactors } : { low: reactors, high: reactors }
  const pplx = (n: number) => n * LAST_RUN.candidate_rate * LAST_RUN.perplexity_per_candidate
  const leadsPerReactor = ran && (inf.last_reactors ?? 0) > 0 ? (inf.last_leads ?? 0) / inf.last_reactors! : 1 / LAST_RUN.reactors_per_lead
  const pct700 = ran && (inf.last_leads ?? 0) > 0 ? (inf.last_leads_700 ?? 0) / inf.last_leads! : LAST_RUN.pct_700_of_verified / 100
  const leads: Range = { low: Math.round(newReactors.low * leadsPerReactor), high: Math.round(newReactors.high * leadsPerReactor) }
  const zeroYield = ran && (inf.last_leads ?? 0) === 0
  return {
    slug: inf.slug,
    name: inf.name,
    basis: ran ? 'last_run' : 'benchmark',
    last_ran_at: inf.last_ran_at,
    posts,
    posts_usd: cents((posts * PRICES.posts_per_1k) / 1000),
    posts_reserve_usd: postsReserveUsd(inf.last_posts),
    reactions,
    reactions_usd: { low: cents(usd(reactions.low)), expected: cents(usd(reactions.expected)), high: cents(usd(reactions.high)) },
    new_reactors: newReactors,
    perplexity_usd: { low: cents(pplx(newReactors.low)), high: cents(pplx(newReactors.high)) },
    haiku_usd: cents(newReactors.high * PRICES.haiku_per_reactor),
    leads_per_reactor: leadsPerReactor,
    leads,
    leads_700: { low: Math.round(leads.low * pct700), high: Math.round(leads.high * pct700) },
    last_cost_usd: num(inf.last_cost_usd),
    last_leads: inf.last_leads,
    last_leads_700: inf.last_leads_700,
    zero_yield: zeroYield,
    warning: zeroYield ? (inf.notes ?? 'No verified leads last run.') : null,
  }
}

export interface RunEstimate {
  influencers: number
  /** Approval 1 (start_influencer_run): the posts scrape, at last run's post counts. */
  posts_usd_now: number
  /** The Apify maximum the posts runs may charge (reserved on the shared monthly cap). */
  posts_reserve_usd: number
  haiku_top_posts_usd: number
  /** Approval 2 (approve_reactions), exact after top posts. */
  reactions_usd: Range3
  perplexity_usd: Range
  perplexity_capped: boolean
  max_verify_usd: number
  haiku_usd: number
  total_usd: Range
  leads: Range
  leads_700: Range
  last_run_cost_usd: number
  per_influencer: InfluencerEstimate[]
  warnings: string[]
  approvals: string[]
}

export function estimateRun(rows: InfluencerRow[], opts: { maxVerifyUsd: number }): RunEstimate {
  const per = rows.map(estimateInfluencer)
  const sum = (f: (e: InfluencerEstimate) => number) => per.reduce((s, e) => s + f(e), 0)
  const rawUsd = (n: number) => (n * PRICES.reactions_per_1k) / 1000
  const reactions: Range3 = {
    low: cents(sum((e) => rawUsd(e.reactions.low))),
    expected: cents(sum((e) => rawUsd(e.reactions.expected))),
    high: cents(sum((e) => rawUsd(e.reactions.high))),
  }
  const pplxRaw: Range = { low: sum((e) => e.perplexity_usd.low), high: sum((e) => e.perplexity_usd.high) }
  const perplexity: Range = { low: cents(Math.min(pplxRaw.low, opts.maxVerifyUsd)), high: cents(Math.min(pplxRaw.high, opts.maxVerifyUsd)) }
  const postsNow = cents(sum((e) => (e.posts * PRICES.posts_per_1k) / 1000))
  const haikuTop = cents(sum((e) => e.posts) * 0.00005)
  const haiku = cents(sum((e) => e.haiku_usd))
  return {
    influencers: per.length,
    posts_usd_now: postsNow,
    posts_reserve_usd: cents(sum((e) => e.posts_reserve_usd)),
    haiku_top_posts_usd: haikuTop,
    reactions_usd: reactions,
    perplexity_usd: perplexity,
    perplexity_capped: pplxRaw.high > opts.maxVerifyUsd,
    max_verify_usd: opts.maxVerifyUsd,
    haiku_usd: haiku,
    total_usd: {
      low: cents(postsNow + haikuTop + reactions.low + perplexity.low + haiku),
      high: cents(postsNow + haikuTop + reactions.high + perplexity.high + haiku),
    },
    leads: { low: sum((e) => e.leads.low), high: sum((e) => e.leads.high) },
    leads_700: { low: sum((e) => e.leads_700.low), high: sum((e) => e.leads_700.high) },
    last_run_cost_usd: cents(sum((e) => e.last_cost_usd ?? 0)),
    per_influencer: per,
    warnings: per.filter((e) => e.warning).map((e) => `${e.name}: ${e.warning}`),
    approvals: [
      `start_influencer_run: posts scrape ~$${postsNow.toFixed(2)} (Apify charge capped at $${cents(sum((e) => e.posts_reserve_usd)).toFixed(2)}) + Haiku top-posts ranking; stops after top posts.`,
      `approve_reactions: the exact reactions bill from top posts (expected $${reactions.low.toFixed(2)}-$${reactions.high.toFixed(2)}), then triage and Perplexity verify capped at $${opts.maxVerifyUsd.toFixed(2)}.`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Apollo contact-import CSV

export interface ExportReactor {
  id: number
  name: string | null
  linkedin_url: string
  title: string | null
  company_name: string | null
  company_website: string | null
  location: string | null
  city: string | null
  state: string | null
  country: string | null
  door_count: number | null
  reacted_to: string[]
}

export const APOLLO_CONTACT_COLUMNS = ['First Name', 'Last Name', 'Title', 'Company', 'Website', 'Person Linkedin Url', 'City', 'State', 'Country'] as const

export function exportColumns(opts: { doorCount?: boolean; reactedTo?: boolean }): string[] {
  return [...APOLLO_CONTACT_COLUMNS, ...(opts.doorCount ? ['Door Count'] : []), ...(opts.reactedTo ? ['Reacted To'] : [])]
}

const NAME_PREFIX = /^(dr|mr|mrs|ms|miss|mx|prof)\.?$/i
const NAME_SUFFIX = /^(mba|cpm|ccim|rmp|mpm|cam|crm|arm|cpa|cfp|esq|phd|md|jd|jr|sr|ii|iii|iv)\.?$/i

/**
 * First and last name. Dropped: everything after a comma ("Brad Randall, CPM"),
 * parentheses, honorific prefixes (Dr., Mr., Mrs., Ms.) and trailing
 * credentials or generational suffixes (MBA, CPM, CCIM, RMP, MPM, CAM, CRM,
 * PhD, Jr., Sr., II, III).
 */
export function splitName(raw: string | null): { first: string; last: string } {
  const words = (raw ?? '').split(',')[0].replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  while (words.length > 1 && NAME_PREFIX.test(words[0])) words.shift()
  while (words.length > 1 && NAME_SUFFIX.test(words[words.length - 1])) words.pop()
  if (!words.length) return { first: '', last: '' }
  const [first, ...rest] = words
  return { first, last: rest.join(' ') }
}

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
}
const US_STATE_NAMES = new Set(Object.values(US_STATES).map((s) => s.toLowerCase()))
const isUsState = (s: string) => !!US_STATES[s.toUpperCase()] || US_STATE_NAMES.has(s.toLowerCase())

/** "Ogden, Utah" → Ogden / Utah / United States; "Toronto, Ontario, Canada" → all three. */
export function splitLocation(raw: string | null): { city: string; state: string; country: string } {
  const parts = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 3) return { city: parts[0], state: parts[1], country: parts.slice(2).join(', ') }
  if (parts.length === 2) return { city: parts[0], state: parts[1], country: isUsState(parts[1]) ? 'United States' : '' }
  if (parts.length === 1) return isUsState(parts[0]) ? { city: '', state: parts[0], country: 'United States' } : { city: parts[0], state: '', country: '' }
  return { city: '', state: '', country: '' }
}

/**
 * One CSV cell: newlines flattened and the ends trimmed (a leading tab or CR
 * goes), a leading = + - @ (the OWASP formula-injection set) prefixed with ',
 * quoted when needed. Numbers are written as numbers.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  let s = v === null || v === undefined ? '' : String(v)
  s = s.replace(/[\r\n]+/g, ' ').trim()
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function influencerApolloCsv(
  reactors: readonly ExportReactor[],
  opts: { names: Record<string, string>; doorCount?: boolean; reactedTo?: boolean }
): { csv: string; rows: number } {
  const lines = [exportColumns(opts).map(csvCell).join(',')]
  for (const r of reactors) {
    const { first, last } = splitName(r.name)
    const loc = splitLocation(r.location)
    const cells: (string | number | null)[] = [
      first,
      last,
      r.title,
      r.company_name,
      domainOf(r.company_website),
      r.linkedin_url,
      r.city || loc.city,
      r.state || loc.state,
      r.country || loc.country,
    ]
    if (opts.doorCount) cells.push(r.door_count)
    if (opts.reactedTo) cells.push(r.reacted_to.map((s) => opts.names[s] ?? s).join('; '))
    lines.push(cells.map(csvCell).join(','))
  }
  return { csv: lines.join('\n') + '\n', rows: reactors.length }
}

/** What the owner does with the CSV; Lume never talks to Apollo. */
export const APOLLO_IMPORT_STEPS = [
  'Download the CSV from the link.',
  'In Apollo: Contacts → Import → CSV, upload the file and add the contacts to a new list (the columns are named the way Apollo maps them; Door Count and Reacted To map to custom fields if you keep them).',
  'Open that list as a People search (Search → People, filter by the list) and copy the search URL from the address bar.',
  'Paste the search URL here in Lume: it becomes a Leadsfriday order (create_order) that waits for a lead-count choice before anything is spent.',
]
