import type { GateRow, Json, PendingActionKind, PendingActionRow } from '@/lib/db/types'
import { ACTION_LABEL } from '@/lib/operators/checkin'

/**
 * The Approvals list (`/actions`), the nav badge and the ICP check's
 * pending-action box, pure. Nothing here decides: Confirm / Cancel go through
 * `/api/actions/<id>/decide` (components/actions/decide.ts).
 */

const num = (v: Json | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const first = (...vs: (Json | undefined)[]): number | null => {
  for (const v of vs) {
    const n = num(v)
    if (n !== null) return n
  }
  return null
}

/**
 * The most this action may spend, in USD, or null when it spends nothing (or
 * the payload names no cap). Each money kind keeps its cap under its own key:
 *
 *  company_check, influencer_lookup  max_usd
 *  run_actor                         budget_usd (the Apify hard cap), else cap_usd
 *  influencer_reactions              max_charge_usd (Apify) + max_verify_usd (Perplexity)
 *  influencer_run                    one tap: reactions_max_charge_usd + max_verify_usd;
 *                                    else posts_usd + posts_reserve_usd (the first stop)
 *  anything                          approved_usd when set
 */
export function capOf(kind: PendingActionKind | string, payload: Record<string, Json> | null | undefined): number | null {
  const p = payload ?? {}
  switch (kind) {
    case 'company_check':
    case 'influencer_lookup':
      return first(p.max_usd, p.approved_usd)
    case 'run_actor':
      return first(p.budget_usd, p.cap_usd)
    case 'influencer_reactions': {
      const charge = first(p.max_charge_usd, p.reactions_usd, p.approved_usd)
      if (charge === null) return null
      return round2(charge + (num(p.max_verify_usd) ?? 0))
    }
    case 'influencer_run': {
      const approved = num(p.approved_usd)
      if (approved !== null) return approved
      const oneTap = num(p.reactions_max_charge_usd)
      if (oneTap !== null) return round2(oneTap + (num(p.max_verify_usd) ?? 0))
      const posts = num(p.posts_usd)
      if (posts === null) return null
      return round2(posts + (num(p.posts_reserve_usd) ?? 0))
    }
    default:
      return num(p.approved_usd) ?? num(p.max_usd)
  }
}

/** The expected spend, when the payload carries one. */
export function estimateOf(kind: PendingActionKind | string, payload: Record<string, Json> | null | undefined): number | null {
  const p = payload ?? {}
  switch (kind) {
    case 'influencer_reactions':
      return num(p.reactions_usd)
    case 'influencer_run':
      return first(p.reactions_usd, p.posts_usd)
    default:
      return num(p.estimate_usd)
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export const formatUsd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`)

/**
 * The warning a card shows when its Telegram prompt never went out
 * ('skipped' / 'failed'), e.g. "Telegram not sent: missing token". Null for
 * 'sent' and for rows filed before notify tracking (notify_status null).
 */
export function notifyWarning(row: Pick<PendingActionRow, 'notify_status' | 'notify_error'>): string | null {
  if (row.notify_status !== 'skipped' && row.notify_status !== 'failed') return null
  const why = row.notify_error?.trim()
  if (why) return `Telegram not sent: ${why}`
  return row.notify_status === 'failed' ? 'Telegram not sent: the send failed' : 'Telegram not sent'
}

export const kindLabel = (kind: string) => ACTION_LABEL[kind] ?? kind.replaceAll('_', ' ')

export interface ApprovalItem {
  id: string
  kind: string
  label: string
  summary: string
  cap_usd: number | null
  estimate_usd: number | null
  requested_by: string
  created_at: string
  notify_warning: string | null
  /** Decided from its own page only (the sign-in link is shown once there). */
  open_only: boolean
}

/** Kinds whose decision must happen on `/actions/<id>`, not inline in the list. */
const OPEN_ONLY = new Set<string>(['issue_operator_key'])

export function toApprovalItem(row: PendingActionRow): ApprovalItem {
  const p = row.payload ?? {}
  return {
    id: row.id,
    kind: row.kind,
    label: kindLabel(row.kind),
    summary: typeof p.summary === 'string' && p.summary.trim() ? p.summary : kindLabel(row.kind),
    cap_usd: capOf(row.kind, p),
    estimate_usd: estimateOf(row.kind, p),
    requested_by: row.requested_by,
    created_at: row.created_at,
    notify_warning: notifyWarning(row),
    open_only: OPEN_ONLY.has(row.kind),
  }
}

/** Newest first. */
export const sortNewest = <T extends { created_at: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))

/** The nav badge text: null at 0 (no badge), "99+" past 99. */
export function badgeText(count: number | null | undefined): string | null {
  if (!count || count < 1 || !Number.isFinite(count)) return null
  return count > 99 ? '99+' : String(Math.floor(count))
}

/** "just now", "5 min", "3 h", "2 d" since `iso`. */
export function ageOf(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

const SCOPE_WORDS: Record<string, string> = { sending: 'Still sending', all: 'All valid leads' }

/**
 * A company_check payload as labelled rows: the `/actions/<id>` card and the
 * ICP screen's "Pending action" box (whose counts are the action's payload).
 */
export function companyCheckRows(payload: Record<string, Json> | null | undefined): [string, string][] {
  const p = payload ?? {}
  const out: [string, string][] = []
  if (typeof p.job_name === 'string') out.push(['job', p.job_name])
  if (typeof p.icp === 'string') out.push(['ICP', p.icp])
  if (typeof p.scope === 'string') out.push(['scope', SCOPE_WORDS[p.scope] ?? p.scope])
  const companies = num(p.companies)
  if (companies !== null) {
    const cached = num(p.cached)
    out.push(['companies', `${companies.toLocaleString('en-US')} to check${cached ? ` (${cached.toLocaleString('en-US')} already checked, free)` : ''}`])
  }
  out.push(['estimate', formatUsd(estimateOf('company_check', p))])
  out.push(['cap', formatUsd(capOf('company_check', p))])
  return out
}

/** The ICP screen's pending-action box: the filed action's own numbers, labelled apart from the live quote. */
export function pendingCheckBox(gate: Pick<GateRow, 'target_id' | 'counts' | 'created_at'>): { href: string; heading: string; rows: [string, string][]; filed: string } {
  return {
    href: `/actions/${gate.target_id}`,
    heading: 'Pending action',
    rows: companyCheckRows(gate.counts),
    filed: gate.created_at,
  }
}
