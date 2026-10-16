/**
 * Pure helpers for the per-lead table (`validation_rows`). Name fields use
 * the same coalesce keys as the `lume_lead_bank` view so the two screens
 * agree on who a row is.
 */

export const NAME_KEYS = {
  first_name: ['First Name', 'first_name'],
  last_name: ['Last Name', 'last_name'],
  company_name: ['Company Name', 'company_name', 'Company'],
} as const

export type NameField = keyof typeof NAME_KEYS

export const ROW_STATUSES = ['pending', 'valid', 'invalid', 'error', 'no_email'] as const
export type RowStatus = (typeof ROW_STATUSES)[number]

export interface RawValidationRow {
  id: string
  row_index: number
  email: string | null
  status: string
  validation_result: { message?: unknown } | null
  enrichment_status: string | null
  instantly_status: string | null
  row_data: Record<string, unknown> | null
}

export interface ValidationRowView {
  id: string
  row_index: number
  email: string | null
  status: string
  message: string | null
  enrichment_status: string | null
  icp_status: string | null
  instantly_status: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
  /** The `row_data` key each name field reads from (or would be written to). */
  name_keys: Record<NameField, string>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** First key present with a non-empty value; else the first key present; else the first candidate. */
function pick(data: Record<string, unknown>, keys: readonly string[]): { key: string; value: string | null } {
  for (const k of keys) {
    const v = str(data[k])
    if (v !== null) return { key: k, value: v }
  }
  const present = keys.find((k) => k in data)
  return { key: present ?? keys[0], value: null }
}

export function toRowView(r: RawValidationRow): ValidationRowView {
  const data = r.row_data ?? {}
  const first = pick(data, NAME_KEYS.first_name)
  const last = pick(data, NAME_KEYS.last_name)
  const company = pick(data, NAME_KEYS.company_name)
  return {
    id: r.id,
    row_index: r.row_index,
    email: r.email,
    status: r.status,
    message: str(r.validation_result?.message),
    enrichment_status: r.enrichment_status,
    icp_status: str(data.icp_status),
    instantly_status: r.instantly_status,
    first_name: first.value,
    last_name: last.value,
    company_name: company.value,
    name_keys: { first_name: first.key, last_name: last.key, company_name: company.key },
  }
}

/** Shallow merge: patched keys replace, every other key is kept. */
export function mergeRowData(
  current: Record<string, unknown> | null,
  patch: Record<string, string | null>
): Record<string, unknown> {
  return { ...(current ?? {}), ...patch }
}

export const ROWS_PAGE_SIZE = 100
