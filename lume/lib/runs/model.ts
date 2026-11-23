import type { ProgressKind } from '@/lib/progress/model'

/**
 * Run detail pages (`/runs/<kind>/<id>`): which kinds exist, how their ids
 * look, and the pure mappers the detail views render. No I/O here; loaders
 * live in lib/runs/load.ts (server-only).
 */

export const RUN_KINDS: readonly ProgressKind[] = ['validation', 'apify', 'influencer_run', 'influencer_lookup', 'leadsfriday_order', 'job_batch', 'company_check']

export const isRunKind = (v: string): v is ProgressKind => (RUN_KINDS as readonly string[]).includes(v)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Apify run ids are short alphanumerics (e.g. `HG7ML7M8z78YcAPEB`); every other kind is a row uuid. */
const APIFY_ID_RE = /^[A-Za-z0-9]{1,64}$/

/** The id in the URL, normalised; null = not a valid id for this kind (→ 404). */
export function parseRunId(kind: ProgressKind, raw: string | undefined): string | null {
  if (!raw) return null
  if (kind === 'apify') return APIFY_ID_RE.test(raw) ? raw : null
  return UUID_RE.test(raw) ? raw.toLowerCase() : null
}

/** Where an activity card's "Open" goes: always the run itself. */
export { runHref } from '@/lib/progress/model'

export const KIND_LABEL: Record<ProgressKind, string> = {
  validation: 'Validation',
  apify: 'Apify run',
  influencer_run: 'Influencer run',
  influencer_lookup: 'LinkedIn lookup',
  leadsfriday_order: 'Leadsfriday order',
  job_batch: 'Job-search batch',
  company_check: 'Company check',
}

// ── Shared formatting ──────────────────────────────────────────────────────

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export const usdText = (v: unknown, digits = 2) => {
  const n = num(v)
  return n === null ? '—' : `$${n.toFixed(digits)}`
}

export type StatusTone = 'live' | 'ok' | 'bad' | 'idle'

const LIVE = new Set(['running', 'awaiting_approval', 'looking_up', 'processing', 'pending', 'ordering', 'ordered', 'resolving', 'delivered', 'ready', 'staged', 'awaiting_review', 'awaiting_count'])
const OK = new Set(['done', 'succeeded', 'completed', 'ingested', 'written', 'ranked', 'imported', 'approved'])
const BAD = new Set(['failed', 'cancelled', 'aborted', 'timed_out', 'timed-out', 'capped', 'error', 'discarded'])

/** Colour of a status word, any kind (Apify's upper-case statuses included). */
export function statusTone(status: string | null | undefined): StatusTone {
  const s = (status ?? '').toLowerCase().replace(/ /g, '_')
  if (BAD.has(s)) return 'bad'
  if (OK.has(s)) return 'ok'
  if (LIVE.has(s)) return 'live'
  return 'idle'
}

export const statusText = (status: string | null | undefined) => (status ?? 'unknown').toLowerCase().replace(/_/g, ' ')

// ── Spend vs cap (company check, lookups) ──────────────────────────────────

export interface SpendBar {
  spent: number
  cap: number | null
  /** 0–100, null without a cap. */
  pct: number | null
  over: boolean
  label: string
}

/** "$X of $Y" and the bar's fill; a missing / zero cap shows the spend alone. */
export function spendVsCap(spentRaw: unknown, capRaw: unknown): SpendBar {
  const spent = Math.max(0, num(spentRaw) ?? 0)
  const capN = num(capRaw)
  const cap = capN !== null && capN > 0 ? capN : null
  if (cap === null) return { spent, cap: null, pct: null, over: false, label: `${usdText(spent)} spent (no cap)` }
  const pct = Math.min(100, Math.round((spent / cap) * 1000) / 10)
  return { spent, cap, pct, over: spent > cap, label: `${usdText(spent)} of ${usdText(cap)}` }
}

// ── Influencer run: people ────────────────────────────────────────────────

export interface ReactorRow {
  id: number | string
  name: string | null
  headline: string | null
  linkedin_url: string
  triage: 'likely' | 'possible' | 'no' | null
  verdict: 'verified' | 'rejected' | 'error' | null
  verify_reason: string | null
  skip_reason: string | null
  company_name: string | null
  company_website: string | null
  door_count: number | null
  exported_at: string | null
  first_seen_run: string | null
  last_seen_run: string | null
}

export type PeopleGroup = 'passed' | 'dropped' | 'known'

export interface PersonView extends ReactorRow {
  group: PeopleGroup
  /** Why it was dropped or skipped; null for passed. */
  reason: string | null
  /** First seen in this run (new) or an earlier one (known). */
  seen: 'new' | 'known'
}

export const COMMENTS_LANE_REASON = 'already in the comments lane (GTM-14)'
export const TRIAGE_NO_REASON = 'headline: not a PM decision-maker'

/**
 * Why a reactor did not pass, or null when it did not get dropped:
 * comments lane (skip_reason) first, since triage skips those rows; then a
 * Perplexity rejection (its reason); then the headline triage.
 */
export function dropReason(r: Pick<ReactorRow, 'skip_reason' | 'verdict' | 'verify_reason' | 'triage'>): string | null {
  if (r.skip_reason === 'already_in_signal') return COMMENTS_LANE_REASON
  if (r.verdict === 'verified') return null
  if (r.verdict === 'rejected') return r.verify_reason?.trim() || 'rejected at verify (no reason recorded)'
  if (r.triage === 'no') return TRIAGE_NO_REASON
  return null
}

/** Not passed, not dropped: why it is sitting out. */
function skippedReason(r: ReactorRow, runId: string): string {
  if (r.verdict === 'error') return 'verify failed (retried next run)'
  if (r.first_seen_run && r.first_seen_run !== runId) return 'known from an earlier run'
  if (r.triage === null) return 'not triaged yet'
  return 'awaiting verify'
}

export function classifyReactor(r: ReactorRow, runId: string): PersonView {
  const seen = r.first_seen_run === runId ? 'new' : 'known'
  const reason = dropReason(r)
  if (reason) return { ...r, group: 'dropped', reason, seen }
  if (r.verdict === 'verified') return { ...r, group: 'passed', reason: null, seen }
  return { ...r, group: 'known', reason: skippedReason(r, runId), seen }
}

export interface PeopleGroups {
  passed: PersonView[]
  dropped: PersonView[]
  known: PersonView[]
  /** Dropped people per reason, most first. */
  dropReasons: { reason: string; count: number }[]
  exported: number
}

/** Passed (most doors first), dropped and known / skipped, plus the drop reasons tally and how many were exported. */
export function groupReactors(rows: readonly ReactorRow[], runId: string): PeopleGroups {
  const out: PeopleGroups = { passed: [], dropped: [], known: [], dropReasons: [], exported: 0 }
  const tally = new Map<string, number>()
  for (const r of rows) {
    const p = classifyReactor(r, runId)
    out[p.group].push(p)
    if (p.group === 'dropped' && p.reason) {
      // Perplexity reasons are free text: tally them under one heading.
      const key = p.reason === COMMENTS_LANE_REASON || p.reason === TRIAGE_NO_REASON ? p.reason : 'rejected at verify'
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    if (r.exported_at) out.exported++
  }
  out.passed.sort((a, b) => (b.door_count ?? -1) - (a.door_count ?? -1))
  out.dropReasons = [...tally].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
  return out
}

// ── Influencer run: posts and GTM-14 cards ────────────────────────────────

export interface SignalPostRow {
  post_id: string
  post_url: string
  posted_at: string | null
  reactions_status: string | null
  digest_status: 'ready' | 'dry_run' | 'posted' | 'empty' | null
  digest_posted_at: string | null
}

export const DIGEST_LABEL: Record<string, string> = {
  ready: 'card ready',
  dry_run: 'card (dry run)',
  posted: 'card posted to Slack',
  empty: 'no card (nobody passed)',
}

export const digestText = (s: SignalPostRow['digest_status']) => (s ? (DIGEST_LABEL[s] ?? s) : 'no card yet')

/** How many GTM-14 cards this run produced, by digest status. */
export function digestCounts(posts: readonly Pick<SignalPostRow, 'digest_status'>[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of posts) {
    const k = p.digest_status ?? 'none'
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/** Posts scraped / targeted / ranked, and the reaction headcount, from the run's counts. */
export function runHeadline(counts: Record<string, unknown> | null | undefined): { label: string; value: number }[] {
  const c = counts && typeof counts === 'object' ? counts : {}
  const rows: [string, string][] = [
    ['posts', 'posts scraped'],
    ['targeted_posts', 'targeted posts'],
    ['top_posts', 'top posts'],
    ['reactions', 'reactions'],
    ['unique_reactors', 'unique reactors'],
    ['known_reactors', 'known reactors'],
    ['signal_known', 'already in comments lane'],
    ['triaged', 'triaged'],
    ['candidates', 'PM candidates'],
    ['verified', 'verified'],
    ['rejected', 'rejected'],
  ]
  const out: { label: string; value: number }[] = []
  for (const [k, label] of rows) {
    const v = num((c as Record<string, unknown>)[k])
    if (v !== null) out.push({ label, value: v })
  }
  return out
}

// ── Company check ─────────────────────────────────────────────────────────

/** Companies settled (anything not pending) of the total. */
export function checkedOfTotal(items: Record<string, number> | null | undefined, companiesTotal: number): { checked: number; total: number } {
  const vals = Object.values(items ?? {})
  const total = vals.reduce((n, v) => n + v, 0) || companiesTotal
  return { checked: total - (items?.pending ?? 0), total }
}

// ── LinkedIn lookup ───────────────────────────────────────────────────────

/** Candidates looked up (not pending) of the batch. */
export function lookupProgress(counts: Record<string, number>): { done: number; total: number } {
  const total = Object.values(counts).reduce((n, v) => n + v, 0)
  return { done: total - (counts.pending_lookup ?? 0), total }
}

/** Duration between two instants, "3m 12s" / "1h 4m"; null when either is missing. */
export function duration(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to) return null
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))
  if (!Number.isFinite(s)) return null
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
