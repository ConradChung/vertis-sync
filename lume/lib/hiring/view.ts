/**
 * GTM-19 sheet: row type, list query parsing and the copy text (pure, client-safe).
 */

export interface HiringRow {
  id: number
  signal: 'hiring' | 'new_manager' | 'expansion'
  role_tier: 'leadership' | 'coordinator' | null
  role_title: string | null
  headline: string | null
  source_url: string | null
  posted_at: string | null
  location: string | null
  country: string | null
  company_name: string | null
  company_domain: string | null
  company_website: string | null
  company_phone: string | null
  company_linkedin: string | null
  person_name: string | null
  person_title: string | null
  person_linkedin: string | null
  pm_fit: 'fit' | 'not_fit' | 'unclear' | null
  pm_evidence: string | null
  skip_reason: string | null
  draft_subject: string | null
  draft_body: string | null
  draft_status: 'ready' | 'needs_edit' | 'failed' | null
  draft_violations: { rule: string; message: string; excerpt: string }[] | null
  status: 'new' | 'sent' | 'skipped'
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

export interface HiringListQuery {
  status: 'new' | 'sent' | 'skipped' | 'all'
  signal: 'hiring' | 'new_manager' | 'expansion' | 'all'
  tier: 'leadership' | 'coordinator' | 'all'
  /** true = the audit view: rows the pipeline skipped (with their reason). */
  skipped: boolean
  offset: number
  limit: number
}

const pick = <T extends string>(v: string | null, allowed: readonly T[], d: T): T => (v && (allowed as readonly string[]).includes(v) ? (v as T) : d)

export function parseListQuery(sp: URLSearchParams): HiringListQuery {
  const offset = Math.max(0, Math.min(100_000, Math.floor(Number(sp.get('offset')) || 0)))
  const limit = Math.max(1, Math.min(200, Math.floor(Number(sp.get('limit')) || 100)))
  return {
    status: pick(sp.get('status'), ['new', 'sent', 'skipped', 'all'] as const, 'new'),
    signal: pick(sp.get('signal'), ['hiring', 'new_manager', 'expansion', 'all'] as const, 'all'),
    tier: pick(sp.get('tier'), ['leadership', 'coordinator', 'all'] as const, 'all'),
    skipped: sp.get('skipped') === '1',
    offset,
    limit,
  }
}

/** What "Copy email" puts on the clipboard. */
export const copyText = (r: Pick<HiringRow, 'draft_subject' | 'draft_body'>) => `Subject: ${r.draft_subject ?? ''}\n\n${r.draft_body ?? ''}`.trim()

export const SIGNAL_LABEL: Record<HiringRow['signal'], string> = { hiring: 'Hiring', new_manager: 'New manager', expansion: 'Expansion' }

export const SKIP_LABEL: Record<string, string> = {
  in_lead_bank: 'Already in the lead bank',
  in_campaign: 'In an Instantly campaign',
  not_pm: 'Not a property manager',
  pm_unclear: 'PM check unclear',
  no_domain: 'No company website or name',
  duplicate_company: 'Company already on the sheet',
  check_failed: 'Company check failed',
}
