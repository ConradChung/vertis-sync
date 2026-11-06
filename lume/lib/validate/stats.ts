import { jobTitle } from '@/lib/validate/jobs'

/**
 * Validator quality (pure). Grouped counts come from lume_validation_stats /
 * lume_validation_history (never row by row).
 *  - invalid rate = invalid ÷ (valid + invalid); errors (MX Error, Timeout,
 *    SPAM Block…: inconclusive) and rows without an email are shown apart.
 *  - breakdown by MailTester reason (validation_result.message).
 */

export interface ReasonCount {
  status: string
  reason: string | null
  n: number
}

export interface BreakdownItem {
  status: 'valid' | 'invalid' | 'error' | 'no_email'
  label: string
  n: number
  /** % of the rows checked or skipped (everything but pending). */
  pct: number
}

export interface ValidationStats {
  valid: number
  invalid: number
  error: number
  no_email: number
  pending: number
  /** valid + invalid: the rate's denominator. */
  decided: number
  invalid_rate: number | null
  /** errors ÷ (valid + invalid + error). */
  error_rate: number | null
  breakdown: BreakdownItem[]
}

const pct1 = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null)

export const invalidRate = (valid: number, invalid: number) => pct1(invalid, valid + invalid)

const ORDER: BreakdownItem['status'][] = ['valid', 'invalid', 'error', 'no_email']

export function validationStats(rows: readonly ReasonCount[]): ValidationStats {
  const sum = (s: string) => rows.filter((r) => r.status === s).reduce((n, r) => n + r.n, 0)
  const valid = sum('valid')
  const invalid = sum('invalid')
  const error = sum('error')
  const no_email = sum('no_email')
  const pending = sum('pending')
  const shown = valid + invalid + error + no_email
  const breakdown = ORDER.flatMap((status) =>
    rows
      .filter((r) => r.status === status)
      .sort((a, b) => b.n - a.n)
      .map((r) => ({ status, label: status === 'no_email' ? 'No email' : r.reason?.trim() || (status === 'error' ? 'Error' : status === 'valid' ? 'Valid' : 'Invalid'), n: r.n, pct: pct1(r.n, shown) ?? 0 }))
  )
  return { valid, invalid, error, no_email, pending, decided: valid + invalid, invalid_rate: invalidRate(valid, invalid), error_rate: pct1(error, valid + invalid + error), breakdown }
}

const SOURCE_LABEL: Record<string, string> = { telegram: 'Telegram upload', csv: 'CSV import', apify: 'Apify', slack: 'Slack upload', lume: 'Lume import' }

/** Where a list came from: the ingest's sender (e.g. "Leadsfriday (Apollo link)"), else the job's source in words. */
export function sourceLabel(j: { sender_name: string | null; source: string | null }): string {
  return j.sender_name?.trim() || (j.source ? (SOURCE_LABEL[j.source] ?? j.source) : '—')
}

export interface HistoryJob {
  id: string
  filename: string | null
  source: string | null
  total_rows: number
  created_at: string
  finished_at: string | null
  sender_name: string | null
  ingest_filename: string | null
  valid: number
  invalid: number
  error: number
  no_email: number
  pending: number
  top_invalid_reason: string | null
  top_invalid_count: number | null
}

export function historyRow(j: HistoryJob) {
  const checked = j.valid + j.invalid + j.error
  return {
    id: j.id,
    title: jobTitle(j),
    filename: j.ingest_filename ?? j.filename,
    source: sourceLabel(j),
    total: j.total_rows,
    created_at: j.created_at,
    valid_pct: pct1(j.valid, checked),
    invalid_rate: invalidRate(j.valid, j.invalid),
    error_pct: pct1(j.error, checked),
    no_email: j.no_email,
    top_invalid: j.top_invalid_reason ? `${j.top_invalid_reason} (${(j.top_invalid_count ?? 0).toLocaleString('en-US')})` : null,
  }
}
