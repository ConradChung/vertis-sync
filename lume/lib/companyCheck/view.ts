import type { GateRow } from '@/lib/db/types'
import { FITS, PROPERTY_TYPES, type CheckScope, type Fit, type PropertyType } from '@/lib/companyCheck/model'

/**
 * The Progress page's ICP check panel (components/progress/IcpCheck.tsx),
 * pure: the quote URL, the default scope, the breakdown rows, which awaiting
 * approval belongs to the job, and how a request answer reads. Nothing here
 * spends: the panel only files a `company_check` pending action (POST
 * /api/actions), which always waits for the owner's Confirm.
 */

export const FIT_LABEL: Record<Fit, string> = { fit: 'Fit', not_fit: 'Not fit', unclear: 'Unclear' }
export const TYPE_LABEL: Record<PropertyType, string> = {
  residential: 'Residential',
  mixed: 'Mixed',
  multifamily: 'Multifamily',
  commercial: 'Commercial',
  other: 'Other',
  unknown: 'Unknown',
}
export const SCOPE_LABEL: Record<CheckScope, string> = { sending: 'Still sending', all: 'All valid leads' }

/** "Still sending" when the job has leads in the lead bank, else every valid lead. */
export const defaultScope = (banked: number | null | undefined): CheckScope => ((banked ?? 0) > 0 ? 'sending' : 'all')

export interface QuoteQuery {
  jobId: string
  /** null = let the server pick (the job's ICP, the Kaspen preset, or the default). */
  icp: string | null
  scope: CheckScope
  fit?: Fit | null
  type?: PropertyType | null
  limit?: number
  offset?: number
}

export function companyCheckUrl(q: QuoteQuery): string {
  const p = new URLSearchParams({ job_id: q.jobId, scope: q.scope })
  const icp = q.icp?.trim()
  if (icp) p.set('icp', icp.slice(0, 1000))
  if (q.fit) p.set('fit', q.fit)
  if (q.type) p.set('type', q.type)
  p.set('limit', String(q.limit ?? 50))
  if (q.offset) p.set('offset', String(q.offset))
  return `/api/company-check?${p}`
}

/** The awaiting `company_check` approval for this job (its lume_action gate), if any. */
export function checkGateFor(gates: readonly GateRow[] | undefined, jobId: string): GateRow | null {
  return (gates ?? []).find((g) => g.kind === 'lume_action' && g.title === 'company_check' && g.counts?.job_id === jobId) ?? null
}

export interface BreakdownRow<K extends string> {
  key: K
  label: string
  companies: number
  leads: number
}

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0

/** Companies and leads per verdict, in the fixed order, zero rows dropped. */
export function fitRows(s: { companies_by_fit?: Record<string, number>; leads_by_fit?: Record<string, number> } | null | undefined): BreakdownRow<Fit>[] {
  return FITS.map((k) => ({ key: k, label: FIT_LABEL[k], companies: n(s?.companies_by_fit?.[k]), leads: n(s?.leads_by_fit?.[k]) })).filter((r) => r.companies > 0)
}

/** Companies and leads per property type, residential first, zero rows dropped. */
export function typeRows(s: { companies_by_type?: Record<string, number>; leads_by_type?: Record<string, number> } | null | undefined): BreakdownRow<PropertyType>[] {
  return PROPERTY_TYPES.map((k) => ({ key: k, label: TYPE_LABEL[k], companies: n(s?.companies_by_type?.[k]), leads: n(s?.leads_by_type?.[k]) })).filter((r) => r.companies > 0)
}

/** Companies settled (checked, cached or failed) of all in the run. */
export function runProgress(items: Record<string, number> | undefined, total: number): { done: number; total: number } {
  const all = Object.values(items ?? {}).reduce((a, b) => a + n(b), 0) || total
  return { done: Math.max(0, all - n(items?.pending)), total: all }
}

export const doorsText = (d: number | null | undefined) => (typeof d === 'number' && d > 0 ? new Intl.NumberFormat('en-US').format(d) : '—')

export const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u.slice(0, 40)
  }
}

/** How POST /api/actions answered a "Request check", in the owner's words. */
export function requestOutcome(status: number, body: { error?: string } | null): { tone: 'success' | 'info' | 'error'; message: string } {
  if (status === 201) return { tone: 'success', message: 'ICP check requested — confirm it to start. Nothing is spent until you do.' }
  const err = body?.error ?? ''
  if (status === 409 && err === 'duplicate') return { tone: 'info', message: 'An ICP check for this job is already waiting for your confirmation.' }
  if (status === 409 && err === 'check_running') return { tone: 'info', message: 'A check of this job is already running.' }
  if (status === 409 && err === 'nothing_to_check') return { tone: 'info', message: 'Every company in this scope is already checked for this ICP.' }
  if (status === 409 && err.startsWith('job_')) return { tone: 'info', message: 'Validation must finish before the ICP check.' }
  if (status === 400) return { tone: 'error', message: err.startsWith('max_usd') ? err : 'The ICP must be 3 to 1,000 characters.' }
  return { tone: 'error', message: "Couldn't request the check." }
}
