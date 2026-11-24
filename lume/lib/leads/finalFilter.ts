import { z } from 'zod'
import { describeCriteria, FilterCriteria, matchRows, type FilterAction, type ReviewRow } from '@/lib/review/model'
import type { ListItem } from '@/lib/leads/lists/model'

/**
 * Step 3 · Filtered (pure): a saved filter turns the combined sheet into the
 * final sheet for one campaign. A filter is an ordered list of rules, each the
 * same criteria the review sets use (category, keywords, city, state, rating,
 * reviews, missing fields, duplicate domain) with `exclude` or `keep_only`.
 * The first rule that drops a row records its reason; nothing is deleted, the
 * excluded rows stay in the final sheet marked excluded with that reason
 * ("3 · Filtered — excluded: vendor").
 */

export const FinalRule = z.object({
  criteria: FilterCriteria,
  action: z.enum(['exclude', 'keep_only']).default('exclude'),
  /** Short reason shown on excluded rows ("vendor"); defaults to the rule in words. */
  reason: z.string().trim().min(1).max(80).optional(),
})
export type FinalRule = z.infer<typeof FinalRule>

export const FinalFilter = z.object({
  rules: z.array(FinalRule).min(1).max(20),
})
export type FinalFilter = z.infer<typeof FinalFilter>

export interface FilterInputRow {
  idx: number
  item: ListItem
}

export interface FilterOutcome {
  idx: number
  kept: boolean
  /** "excluded: vendor"; null when kept. */
  note: string | null
  /** The bare reason ("vendor"); null when kept. */
  reason: string | null
}

export interface FinalPlan {
  rows: FilterOutcome[]
  kept: number
  excluded: number
  /** Excluded rows per reason, largest first. */
  reasons: { reason: string; count: number }[]
}

/** A rule's reason: the owner's words, else the rule described ("rating < 4"). */
export function ruleReason(rule: FinalRule): string {
  if (rule.reason?.trim()) return rule.reason.trim()
  return describeCriteria(rule.criteria, rule.action as FilterAction)
    .replace(/^(Exclude|Keep only): /, rule.action === 'keep_only' ? 'not ' : '')
    .slice(0, 80)
}

export function planFinal(rows: readonly FilterInputRow[], filter: FinalFilter): FinalPlan {
  // matchRows works on review rows; every row starts kept, and each rule only sees the rows still kept.
  const state = new Map<number, FilterOutcome>(rows.map((r) => [r.idx, { idx: r.idx, kept: true, note: null, reason: null }]))
  const review = (): ReviewRow[] =>
    rows.map((r) => ({ idx: r.idx, item: r.item, status: state.get(r.idx)!.kept ? 'kept' : 'excluded', excluded_reason: null, filter_id: null }) as ReviewRow)
  for (const rule of filter.rules) {
    const reason = ruleReason(rule)
    const current = review()
    const hit = matchRows(current, rule.criteria)
    for (const r of current) {
      if (r.status !== 'kept') continue
      const drop = rule.action === 'exclude' ? hit.has(r.idx) : !hit.has(r.idx)
      if (drop) state.set(r.idx, { idx: r.idx, kept: false, reason, note: `excluded: ${reason}` })
    }
  }
  const out = rows.map((r) => state.get(r.idx)!)
  const counts = new Map<string, number>()
  for (const o of out) if (!o.kept && o.reason) counts.set(o.reason, (counts.get(o.reason) ?? 0) + 1)
  return {
    rows: out,
    kept: out.filter((o) => o.kept).length,
    excluded: out.filter((o) => !o.kept).length,
    reasons: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  }
}

/** The Filter → Final form on the Leads page (each part optional). */
export interface FinalForm {
  /** Drop rows missing any of these (one rule each, so the reason names the field). */
  require: ('email' | 'phone' | 'website' | 'linkedin')[]
  /** Drop rows whose category is one of these. */
  exclude_categories: string
  /** Drop rows whose name or category has any of these words. */
  exclude_keywords: string
  /** Reason shown on rows the categories / keywords drop ("vendor"). */
  exclude_reason: string
  /** Drop rows rated below this (blank: no rating rule). */
  min_rating: string
  /** Keep only these states (blank: every state). */
  only_states: string
  /** Keep only these cities (blank: every city). */
  only_cities: string
  /** Drop a later row whose domain an earlier kept row already has. */
  drop_duplicate_domains: boolean
}

export const emptyFinalForm = (): FinalForm => ({ require: [], exclude_categories: '', exclude_keywords: '', exclude_reason: '', min_rating: '', only_states: '', only_cities: '', drop_duplicate_domains: false })

const words = (s: string, min = 1) =>
  [...new Set(s.split(/[,\n;]/).map((w) => w.trim()).filter((w) => w.length >= min))].slice(0, 30)

/** The form as a saved filter, or null when it asks for nothing. Rule order = the order reasons are recorded in. */
export function finalFilterFromForm(f: FinalForm): FinalFilter | null {
  const rules: FinalRule[] = []
  for (const field of f.require) rules.push({ criteria: { missing: [field] }, action: 'exclude', reason: `no ${field === 'linkedin' ? 'LinkedIn' : field}` })
  const reason = f.exclude_reason.trim().slice(0, 80) || undefined
  const cats = words(f.exclude_categories)
  if (cats.length) rules.push({ criteria: { categories_in: cats }, action: 'exclude', reason })
  const kw = words(f.exclude_keywords, 2)
  if (kw.length) rules.push({ criteria: { keywords: kw }, action: 'exclude', reason })
  const r = Number(f.min_rating)
  if (f.min_rating.trim() && Number.isFinite(r) && r > 0 && r <= 5) rules.push({ criteria: { rating_below: r }, action: 'exclude', reason: `rating below ${r}` })
  const states = words(f.only_states)
  if (states.length) rules.push({ criteria: { states }, action: 'keep_only', reason: 'outside the chosen states' })
  const cities = words(f.only_cities)
  if (cities.length) rules.push({ criteria: { cities }, action: 'keep_only', reason: 'outside the chosen cities' })
  if (f.drop_duplicate_domains) rules.push({ criteria: { duplicate_domain: true }, action: 'exclude', reason: 'duplicate domain' })
  return rules.length ? FinalFilter.parse({ rules }) : null
}
