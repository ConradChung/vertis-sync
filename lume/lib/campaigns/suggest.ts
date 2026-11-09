/**
 * New-campaign suggestions inferred from the leads (pure, client-safe, no
 * I/O, no LLM). The server loader (lib/campaigns/suggestData.ts) feeds it a
 * sample of a lead set (≤ 500 rows), the tags (lume_verticals with their
 * `keywords`), the templates, the Instantly campaigns' settings and past
 * jobs' profiles; this module decides.
 *
 *   profileLeads     → top industries / titles / keywords / locations / roles,
 *                      from whichever columns exist (case-insensitive headers,
 *                      dotted lead-list keys like `profile.title` included)
 *   scoreVerticals   → each tag's share of rows matching its keywords, plus a
 *                      bonus for tags whose past lists looked like this one;
 *                      an item already tagged wins
 *   rankTemplatesFor → the tag's own templates first, then name similarity
 *   suggestName      → "<Tag short> — <segment> — <Mon YYYY>", unique
 *   pickSettings     → inboxes / schedule / daily limit of the tag's most
 *                      recent campaign, else the most recent campaign overall
 *   noLocationAdvice → a sibling without {{location}} when ≥ 10 % of rows have
 *                      no city and the template uses {{location}}
 */

import { LOCATION_TAG } from '@/lib/validate/noLocation'

export type LeadRow = Record<string, unknown>

export const PROFILE_SAMPLE_MAX = 500

export interface Count {
  value: string
  n: number
  /** n / rows, 0–1. */
  share: number
}

export interface LeadProfile {
  rows: number
  /** The headers read for each role. */
  columns: { industry: string[]; title: string[]; keywords: string[]; company: string[]; city: string[]; region: string[] }
  industries: Count[]
  titles: Count[]
  keywords: Count[]
  locations: Count[]
  /** Owner / founder / CEO … found in titles. */
  roles: Count[]
  /** Rows with no city; null when the set has no city column at all. */
  without_city: number | null
  /** Lowercased text per row and field, for keyword scoring (not sent to clients). */
  text: { industry: string[]; title: string[]; keywords: string[]; company: string[] }
}

export interface VerticalInput {
  id: string
  name: string
  keywords: string[]
}

export type ScoreSource = 'tagged' | 'keywords' | 'history' | 'none'

export interface VerticalScore {
  id: string
  name: string
  /** 0–1 from the leads (+ up to 0.3 from history); a tagged item scores 2. */
  score: number
  /** Share of rows matching any of the tag's keywords, 0–1. */
  coverage: number
  /** Best similarity to this tag's past lists, 0–1. */
  history: number
  source: ScoreSource
  /** One short line, e.g. "62% of titles mention property management". */
  why: string
}

export interface HistoryProfile {
  vertical_id: string
  profile: Pick<LeadProfile, 'industries' | 'titles' | 'keywords'>
}

export interface TemplateInput {
  id: string
  name: string
  vertical_id: string | null
  sequences: unknown
}

export interface RankedTemplate {
  id: string
  name: string
  vertical_id: string | null
  no_location: boolean
  uses_location: boolean
  why: string
}

export interface CampaignSetup {
  id: string
  name: string
  /** ISO timestamp the campaign was created, when Instantly reports it. */
  created_at: string | null
  email_list: string[]
  campaign_schedule: unknown
  daily_limit: number | null
  stop_on_reply: boolean | null
}

export interface SettingsSuggestion {
  source_campaign_id: string
  source_campaign_name: string
  email_list: string[]
  campaign_schedule: unknown
  daily_limit: number | null
  stop_on_reply: boolean | null
  why: string
}

export interface NoLocationAdvice {
  advisable: boolean
  rows_without_city: number | null
  share: number | null
  why: string
}

// ---------------------------------------------------------------------------
// Headers

/** "Company.Industry", "# Employees", "job_title" → "company industry", "employees", "job title". */
export function normHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[._\-/#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const lastSeg = (h: string) => {
  const parts = h.split('.')
  return normHeader(parts[parts.length - 1] ?? h)
}

const NOT_A_PERSON_TITLE = /\b(article|doc|post|page|company|organization|org|website|link|video|image)\b/

type Role = keyof LeadProfile['columns']

/** Which role a header plays (null = ignored). Exported for tests. */
export function headerRole(header: string): Role | null {
  const k = normHeader(header)
  const last = lastSeg(header)
  if (/\b(industry|industries|sector|category)\b/.test(k) && !/\bsub\b/.test(k)) return 'industry'
  if (/\b(keywords?|tags|specialties|specialities|search term)\b/.test(k)) return 'keywords'
  if (/\b(operating city)\b/.test(k)) return 'city'
  if (['title', 'job title', 'headline', 'position', 'role', 'seniority', 'job'].includes(last) && !NOT_A_PERSON_TITLE.test(k.replace(last, ''))) return 'title'
  if (['company', 'company name', 'organization', 'organization name', 'account name', 'business name'].includes(k) || k === 'company name for emails' || /^(company|organization) name$/.test(last) || (last === 'name' && /\bcompany\b/.test(k))) return 'company'
  if (/\bcity$/.test(last)) return 'city'
  if (/\b(state|region|province|country)$/.test(last)) return 'region'
  return null
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

const NO_CITY = /^(|unknown|error|n\/a|na|none|null|-)$/i

/** The city columns in preference order: operating city, the person's city, then a company / HQ city. */
function orderCity(cols: string[]): string[] {
  const rank = (c: string) => {
    const k = normHeader(c)
    if (/operating city/.test(k)) return 0
    if (/\b(company|hq|organization|headquarter)\b/.test(k)) return 2
    return 1
  }
  return [...cols].sort((a, b) => rank(a) - rank(b))
}

// ---------------------------------------------------------------------------
// Profile

const ROLES: [RegExp, string][] = [
  [/\b(co-?owner|owner|proprietor)\b/, 'owner'],
  [/\b(co-?founder|founder)\b/, 'founder'],
  [/\b(ceo|chief executive)\b/, 'CEO'],
  [/\bpresident\b/, 'president'],
  [/\bprincipal\b/, 'principal'],
  [/\b(managing )?partner\b/, 'partner'],
  [/\bbroker\b/, 'broker'],
  [/\b(vp|vice president)\b/, 'VP'],
  [/\b(director|head)\b/, 'director'],
  [/\b(manager|mgr)\b/, 'manager'],
  [/\b(recruiter|talent)\b/, 'recruiter'],
  [/\b(account executive|ae|sdr|bdr|sales)\b/, 'seller'],
]

export function roleOf(title: string): string | null {
  const t = title.toLowerCase()
  for (const [re, role] of ROLES) if (re.test(t)) return role
  return null
}

function top(counts: Map<string, number>, rows: number, n: number): Count[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([value, c]) => ({ value, n: c, share: rows ? c / rows : 0 }))
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

/** Profile a lead sample (only the first PROFILE_SAMPLE_MAX rows are read). */
export function profileLeads(input: readonly LeadRow[], topN = 8): LeadProfile {
  const rows = input.slice(0, PROFILE_SAMPLE_MAX)
  const headers = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r ?? {})) headers.add(k)
  const columns: LeadProfile['columns'] = { industry: [], title: [], keywords: [], company: [], city: [], region: [] }
  for (const h of headers) {
    const role = headerRole(h)
    if (role) columns[role].push(h)
  }
  columns.city = orderCity(columns.city)
  // The person's state / country before a company's.
  columns.region.sort((a, b) => Number(/company|hq|organization/.test(normHeader(a))) - Number(/company|hq|organization/.test(normHeader(b))))

  const industries = new Map<string, number>()
  const titles = new Map<string, number>()
  const keywords = new Map<string, number>()
  const locations = new Map<string, number>()
  const roles = new Map<string, number>()
  const text: LeadProfile['text'] = { industry: [], title: [], keywords: [], company: [] }
  let withoutCity = 0

  for (const r of rows) {
    const vals = (cols: string[]) => cols.map((c) => str(r?.[c])).filter(Boolean)
    const ind = vals(columns.industry)
    const tit = vals(columns.title)
    const kw = vals(columns.keywords)
    const co = vals(columns.company)
    text.industry.push(ind.join(' | ').toLowerCase())
    text.title.push(tit.join(' | ').toLowerCase())
    text.keywords.push(kw.join(' | ').toLowerCase())
    text.company.push(co.join(' | ').toLowerCase())

    const rowInd = new Set(ind.flatMap((v) => v.split(/[;|]/)).map((v) => v.trim().toLowerCase()).filter(Boolean))
    for (const v of rowInd) bump(industries, v)
    // The first title column that is not just a seniority word.
    const mainTitle = tit[0]
    if (mainTitle) bump(titles, mainTitle.toLowerCase().replace(/\s+/g, ' ').slice(0, 80))
    const role = roleOf(tit.join(' '))
    if (role) bump(roles, role)
    const rowKw = new Set(kw.flatMap((v) => v.split(/[,;|]/)).map((v) => v.trim().toLowerCase()).filter((v) => v && v.length <= 60))
    for (const v of rowKw) bump(keywords, v)

    if (columns.city.length) {
      // The no-location test follows the first city column present (operating city when enriched).
      const city = str(r?.[columns.city[0]])
      if (NO_CITY.test(city)) withoutCity++
    }
    const cityAny = vals(columns.city)[0]
    const region = vals(columns.region)[0]
    const loc = region || cityAny
    if (loc) bump(locations, loc)
  }

  const n = rows.length
  return {
    rows: n,
    columns,
    industries: top(industries, n, topN),
    titles: top(titles, n, topN),
    keywords: top(keywords, n, topN),
    locations: top(locations, n, topN),
    roles: top(roles, n, topN),
    without_city: columns.city.length ? withoutCity : null,
    text,
  }
}

/** The profile without the per-row text (what goes to clients). */
export function publicProfile(p: LeadProfile): Omit<LeadProfile, 'text'> {
  const { text: _text, ...rest } = p
  void _text
  return rest
}

// ---------------------------------------------------------------------------
// Tag scoring

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whole-word (plural-tolerant) keyword matcher. */
export function keywordMatcher(kw: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(kw.toLowerCase().trim())}(s|es)?([^a-z0-9]|$)`)
}

const FIELD_LABEL: Record<keyof LeadProfile['text'], string> = {
  industry: 'industries',
  title: 'titles',
  keywords: 'keyword lists',
  company: 'company names',
}

const pct = (x: number) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`)

/** Cosine similarity over the top-value shares of industries + titles + keywords. */
export function profileSimilarity(a: HistoryProfile['profile'], b: HistoryProfile['profile']): number {
  const vec = (p: HistoryProfile['profile']) => {
    const m = new Map<string, number>()
    for (const [pre, list] of [['i', p.industries], ['t', p.titles], ['k', p.keywords]] as const) for (const c of list) m.set(`${pre}:${c.value}`, c.share)
    return m
  }
  const va = vec(a)
  const vb = vec(b)
  let dot = 0
  for (const [k, x] of va) dot += x * (vb.get(k) ?? 0)
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, x) => s + x * x, 0))
  const d = norm(va) * norm(vb)
  return d ? dot / d : 0
}

export const HISTORY_WEIGHT = 0.3
/** Below this a tag is not suggested (the owner picks). */
export const MIN_SUGGEST_SCORE = 0.1

/**
 * Rank the tags for a profile. `taggedVerticalId`: the item's own tag, which
 * wins outright. `history`: past lists with the tag they went out under.
 */
export function scoreVerticals(
  profile: LeadProfile,
  verticals: readonly VerticalInput[],
  opts: { taggedVerticalId?: string | null; history?: readonly HistoryProfile[] } = {}
): VerticalScore[] {
  const n = profile.rows
  const fields = Object.keys(profile.text) as (keyof LeadProfile['text'])[]
  const out = verticals.map((v): VerticalScore => {
    const kws = [...new Set(v.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))]
    const matchers = kws.map((k) => [k, keywordMatcher(k)] as const)
    let covered = 0
    const perKw = new Map<string, number>() // `${field}\u0000${kw}` → rows
    for (let i = 0; i < n; i++) {
      let hit = false
      for (const f of fields) {
        const t = profile.text[f][i]
        if (!t) continue
        for (const [k, re] of matchers) {
          if (re.test(t)) {
            hit = true
            const key = `${f}\u0000${k}`
            perKw.set(key, (perKw.get(key) ?? 0) + 1)
          }
        }
      }
      if (hit) covered++
    }
    const coverage = n ? covered / n : 0
    let best: { f: keyof LeadProfile['text']; k: string; c: number } | null = null
    for (const [key, c] of perKw) {
      const [f, k] = key.split('\u0000') as [keyof LeadProfile['text'], string]
      // Prefer the stronger field on ties: industry/title over company names.
      if (!best || c > best.c || (c === best.c && k.length > best.k.length)) best = { f, k, c }
    }
    const hist = Math.max(0, ...(opts.history ?? []).filter((h) => h.vertical_id === v.id).map((h) => profileSimilarity(profile, h.profile)))
    const score = coverage + HISTORY_WEIGHT * hist
    let why = ''
    let source: ScoreSource = 'none'
    if (best && n) {
      why = `${pct(best.c / n)} of ${FIELD_LABEL[best.f]} mention ${best.k}`
      source = 'keywords'
    }
    if (hist >= 0.5 && HISTORY_WEIGHT * hist > coverage) {
      why = `Looks like earlier ${v.name} lists (${pct(hist)} similar)`
      source = 'history'
    } else if (hist >= 0.5 && why) {
      why += `; like earlier ${v.name} lists`
    }
    if (!why) why = kws.length ? 'No keyword matches' : 'No keywords set for this tag'
    return { id: v.id, name: v.name, score, coverage, history: hist, source, why }
  })
  const tagged = opts.taggedVerticalId ? out.find((s) => s.id === opts.taggedVerticalId) : undefined
  if (tagged) {
    tagged.why = `Already tagged ${tagged.name}${tagged.source === 'keywords' ? ` (${tagged.why})` : ''}`
    tagged.score = 2
    tagged.source = 'tagged'
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Templates

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !['campaign', 'the', 'and', 'location', 'roles'].includes(t))
  )

export const isNoLocationName = (name: string) => /no[\s-]*location/i.test(name)

/** Does any step's subject / body use {{location}}? */
export function usesLocation(sequences: unknown): boolean {
  if (!Array.isArray(sequences)) return false
  for (const seq of sequences as { steps?: { variants?: { subject?: unknown; body?: unknown }[] }[] }[]) {
    for (const step of Array.isArray(seq?.steps) ? seq.steps : []) {
      for (const v of Array.isArray(step?.variants) ? step.variants : []) {
        if (LOCATION_TAG.test(`${str(v?.subject)}\n${str(v?.body)}`)) return true
      }
    }
  }
  return false
}

/**
 * Templates for a tag: the tag's own first, then by name overlap with the
 * tag's name, then by name. No-Location templates sort after their main one
 * (they are for the sibling, not the main campaign).
 */
export function rankTemplatesFor(templates: readonly TemplateInput[], vertical: { id: string; name: string } | null): RankedTemplate[] {
  const vt = vertical ? tokens(vertical.name) : new Set<string>()
  const scored = templates.map((t) => {
    const own = !!vertical && t.vertical_id === vertical.id
    const overlap = [...tokens(t.name)].filter((x) => vt.has(x)).length
    const noLoc = isNoLocationName(t.name)
    const score = (own ? 100 : 0) + overlap * 10 - (noLoc ? 5 : 0)
    const why = own ? `Tagged ${vertical!.name}` : overlap ? `Name matches ${vertical!.name}` : ''
    return { t, score, noLoc, why }
  })
  scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
  return scored.map(({ t, noLoc, why }) => ({ id: t.id, name: t.name, vertical_id: t.vertical_id, no_location: noLoc, uses_location: usesLocation(t.sequences), why }))
}

// ---------------------------------------------------------------------------
// Name

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Kaspen / Zenport" → "Kaspen"; "HNWI / wealth management" → "HNWI". */
export const verticalShort = (name: string) => name.split(/\s*[/|]\s*/)[0].trim() || name.trim()

const INDUSTRY_SHORT: [RegExp, string][] = [
  [/property manag/, 'PM'],
  [/real estate|realty/, 'Real estate'],
  [/wealth|financial|investment/, 'Wealth'],
  [/roof/, 'Roofing'],
  [/software|saas|internet|information technology/, 'Tech'],
  [/staffing|recruit/, 'Staffing'],
  [/construction|contractor/, 'Construction'],
]

function industryShort(industry: string): string {
  const t = industry.toLowerCase()
  for (const [re, s] of INDUSTRY_SHORT) if (re.test(t)) return s
  const words = industry.trim().split(/\s+/).slice(0, 3).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const plural = (role: string) => (/[A-Z]{2}$/.test(role) ? `${role}s` : role.endsWith('s') ? role : `${role}s`)

/** "PM owners", "Real estate owners", "Founders", or null when the leads don't say. */
export function segmentOf(profile: Pick<LeadProfile, 'industries' | 'roles'>): string | null {
  const ind = profile.industries[0]
  const role = profile.roles[0]
  const i = ind && ind.share >= 0.3 ? industryShort(ind.value) : null
  const r = role && role.share >= 0.25 ? plural(role.value) : null
  if (i && r) return `${i} ${r}`
  if (r) return r.charAt(0).toUpperCase() + r.slice(1)
  return i
}

/** "<Tag short> — <segment> — <Mon YYYY>", made unique against `existing` (case-insensitive) with " (2)", " (3)" … */
export function suggestName(opts: { verticalName: string | null; segment: string | null; now: Date; existing?: readonly string[] }): string {
  const month = `${MONTHS[opts.now.getUTCMonth()]} ${opts.now.getUTCFullYear()}`
  const parts = [opts.verticalName ? verticalShort(opts.verticalName) : 'New campaign', opts.segment, month].filter(Boolean) as string[]
  const base = parts.join(' — ')
  const taken = new Set((opts.existing ?? []).map((s) => s.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; i < 100; i++) {
    const c = `${base} (${i})`
    if (!taken.has(c.toLowerCase())) return c
  }
  return `${base} (${Date.now() % 1000})`
}

// ---------------------------------------------------------------------------
// Settings + No-Location

const createdMs = (c: CampaignSetup) => (c.created_at ? Date.parse(c.created_at) || 0 : 0)

/**
 * Inboxes, schedule and daily limit from the tag's most recent campaign with
 * inboxes (its `campaign_ids` plus campaigns its jobs were pushed to), else
 * the most recent campaign overall; null when there is none.
 */
export function pickSettings(campaigns: readonly CampaignSetup[], verticalCampaignIds: ReadonlySet<string>, verticalName: string | null): SettingsSuggestion | null {
  const usable = campaigns.filter((c) => c.email_list.length > 0).sort((a, b) => createdMs(b) - createdMs(a) || a.name.localeCompare(b.name))
  const own = usable.find((c) => verticalCampaignIds.has(c.id))
  const src = own ?? usable[0]
  if (!src) return null
  return {
    source_campaign_id: src.id,
    source_campaign_name: src.name,
    email_list: [...src.email_list],
    campaign_schedule: src.campaign_schedule ?? null,
    daily_limit: src.daily_limit,
    stop_on_reply: src.stop_on_reply,
    why: own ? `Copied from ${src.name}, the latest ${verticalName ?? 'tagged'} campaign` : `Copied from ${src.name}, the latest campaign${verticalName ? ` (no ${verticalName} campaign yet)` : ''}`,
  }
}

export const NO_LOCATION_MIN_SHARE = 0.1

export function noLocationAdvice(profile: Pick<LeadProfile, 'rows' | 'without_city'>, templateUsesLocation: boolean): NoLocationAdvice {
  if (profile.without_city === null || !profile.rows) {
    return { advisable: false, rows_without_city: null, share: null, why: profile.rows ? 'The leads have no city column' : 'No leads to check' }
  }
  const share = profile.without_city / profile.rows
  const base = { rows_without_city: profile.without_city, share }
  if (!templateUsesLocation) return { ...base, advisable: false, why: 'The template never uses {{location}}' }
  if (share < NO_LOCATION_MIN_SHARE) return { ...base, advisable: false, why: `Only ${pct(share)} of rows have no city` }
  return { ...base, advisable: true, why: `${pct(share)} of rows have no city — a sibling without {{location}} keeps them sendable` }
}

// ---------------------------------------------------------------------------
// Whole suggestion

export interface Suggestion {
  vertical_id: string | null
  vertical_name: string | null
  vertical_why: string
  template_id: string | null
  template_name: string | null
  template_why: string
  name: string
  segment: string | null
  settings: SettingsSuggestion | null
  no_location: NoLocationAdvice
  /** The template the No-Location sibling would use when the main copy can't be stripped. */
  no_location_template_id: string | null
}

export function suggestCampaign(input: {
  profile: LeadProfile | null
  ranked: readonly VerticalScore[]
  templates: readonly TemplateInput[]
  campaigns: readonly CampaignSetup[]
  /** vertical id → campaign ids (its campaign_ids + campaigns its jobs went to). */
  verticalCampaigns: ReadonlyMap<string, ReadonlySet<string>>
  now: Date
}): Suggestion & { templates: RankedTemplate[] } {
  const topV = input.ranked[0]
  const pick = topV && topV.score >= MIN_SUGGEST_SCORE ? topV : null
  const vertical = pick ? { id: pick.id, name: pick.name } : null
  const templates = rankTemplatesFor(input.templates, vertical)
  // Only a template that belongs to (or is named like) the tag is pre-selected: another tag's copy is never suggested.
  const main = templates.find((t) => !t.no_location && t.why) ?? null
  const noLocT = templates.find((t) => t.no_location && (!vertical || t.vertical_id === vertical.id || t.vertical_id === null)) ?? null
  const segment = input.profile ? segmentOf(input.profile) : null
  const name = suggestName({ verticalName: vertical?.name ?? null, segment, now: input.now, existing: input.campaigns.map((c) => c.name) })
  const settings = pickSettings(input.campaigns, (vertical && input.verticalCampaigns.get(vertical.id)) || new Set(), vertical?.name ?? null)
  const no_location = input.profile ? noLocationAdvice(input.profile, main?.uses_location ?? false) : { advisable: false, rows_without_city: null, share: null, why: 'Pick a lead source to check' }
  return {
    vertical_id: vertical?.id ?? null,
    vertical_name: vertical?.name ?? null,
    vertical_why: pick ? pick.why : topV ? `No tag clearly fits (best: ${topV.name}, ${topV.why})` : 'No tags yet',
    template_id: main?.id ?? null,
    template_name: main?.name ?? null,
    template_why: main?.why ?? (templates.length ? 'No template for this tag yet — pick one' : 'No templates yet'),
    name,
    segment,
    settings,
    no_location,
    no_location_template_id: noLocT?.id ?? null,
    templates,
  }
}

// ---------------------------------------------------------------------------
// Sequence preview (the sheet's template preview)

const stripHtml = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export interface SequencePreview {
  steps: number
  variants: number
  subject: string
  body: string
}

/** Step count, first-step variant count, and the first variant's subject + plain-text body (≤ 600 chars). */
export function sequencePreview(sequences: unknown): SequencePreview | null {
  const seq = Array.isArray(sequences) ? (sequences[0] as { steps?: { variants?: { subject?: unknown; body?: unknown }[] }[] }) : null
  const steps = Array.isArray(seq?.steps) ? seq.steps : []
  if (!steps.length) return null
  const variants = Array.isArray(steps[0]?.variants) ? steps[0].variants : []
  const v = variants[0]
  const body = stripHtml(str(v?.body))
  return { steps: steps.length, variants: variants.length, subject: str(v?.subject), body: body.length > 600 ? `${body.slice(0, 599)}…` : body }
}
