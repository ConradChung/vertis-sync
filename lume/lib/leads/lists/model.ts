import { domainOf } from '@/lib/apollo/records'
import { csvCell } from '@/lib/csv/cell'
import { parseCSVRow } from '@/lib/import/csv'
import { leadColumnMapping, mappedRecord, rowRecord, type ColumnMapping } from '@/lib/review/columns'
import { normaliseLead, type LeadItem } from '@/lib/review/model'

/**
 * Lead lists (pure): persistent, named lists the agent and the owner add leads
 * to before validation. Stored as lead_review_sets rows with kind = 'list'
 * (lib/leads/lists/store.ts). Dedupe keys, append planning, paste parsing,
 * cell edits and the CSV the page exports / the validator ingests.
 */

export type ListItem = LeadItem

/** Most rows one list holds. */
export const LIST_MAX_ITEMS = 20_000
/** Most rows the agent may pass inline in one append. */
export const INLINE_MAX_ROWS = 200
/** Most rows one paste may carry. */
export const PASTE_MAX_ROWS = 5_000

export const ITEM_SOURCES = ['attachment', 'actor_run', 'review_set', 'influencer_export', 'manual', 'agent'] as const
export type ItemSource = (typeof ITEM_SOURCES)[number]

/** The fields the owner edits in a cell (and the agent passes inline). */
export const EDITABLE_FIELDS = ['name', 'first_name', 'last_name', 'title', 'company', 'website', 'email', 'phone', 'linkedin_url', 'city', 'state', 'country'] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]

/** Table / CSV columns, in order. */
export const LIST_COLUMNS: { key: EditableField; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'first_name', label: 'First Name' },
  { key: 'last_name', label: 'Last Name' },
  { key: 'title', label: 'Title' },
  { key: 'company', label: 'Company' },
  { key: 'website', label: 'Website' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'linkedin_url', label: 'LinkedIn' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'country', label: 'Country' },
]

export interface DedupeKeys {
  email_key: string | null
  linkedin_key: string | null
  name_key: string | null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const COMPANY_SUFFIX = /\b(inc|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|plc|gmbh|the)\b/g
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s.]/gu, ' ').replace(/\s+/g, ' ').trim()

export function linkedinKey(url: string | null): string | null {
  const m = /linkedin\.com\/(in|company|pub)\/([^/?#\s]+)/i.exec(url ?? '')
  return m ? `${m[1]}/${decodeURIComponent(m[2])}`.toLowerCase() : null
}

/** Email first, then LinkedIn, then normalised person (or business) name + domain (or company). */
export function dedupeKeys(item: ListItem): DedupeKeys {
  const email = item.email?.trim().toLowerCase() ?? ''
  const person = [item.first_name, item.last_name].filter(Boolean).join(' ') || item.name || ''
  const name = squash(person).replace(/\./g, '')
  const org = item.domain?.trim().toLowerCase() || squash(item.company ?? '').replace(/\./g, ' ').replace(COMPANY_SUFFIX, '').replace(/\s+/g, ' ').trim()
  return {
    email_key: EMAIL.test(email) ? email : null,
    linkedin_key: linkedinKey(item.linkedin_url),
    name_key: name && org ? `${name}|${org}` : null,
  }
}

export interface ExistingKeys {
  emails: Set<string>
  linkedins: Set<string>
  names: Set<string>
}

export interface AppendPlan {
  /** Indexes into the incoming rows to insert, in order. */
  add: number[]
  duplicates: number
  /** Rows with no email, LinkedIn or name + company to identify them. */
  skipped: number
  /** Rows past the list's cap. */
  over_cap: number
}

/**
 * Which incoming rows to add: a row is a duplicate when any of its keys is
 * already in the list or earlier in the batch (email, then LinkedIn, then
 * name + company/domain). `room` is how many rows the list still takes.
 */
export function planAppend(existing: ExistingKeys, incoming: readonly ListItem[], room = Infinity): AppendPlan {
  const seen = { emails: new Set(existing.emails), linkedins: new Set(existing.linkedins), names: new Set(existing.names) }
  const plan: AppendPlan = { add: [], duplicates: 0, skipped: 0, over_cap: 0 }
  incoming.forEach((item, i) => {
    const k = dedupeKeys(item)
    if (!k.email_key && !k.linkedin_key && !k.name_key) {
      plan.skipped++
      return
    }
    if ((k.email_key && seen.emails.has(k.email_key)) || (k.linkedin_key && seen.linkedins.has(k.linkedin_key)) || (k.name_key && seen.names.has(k.name_key))) {
      plan.duplicates++
      return
    }
    if (plan.add.length >= room) {
      plan.over_cap++
      return
    }
    plan.add.push(i)
    if (k.email_key) seen.emails.add(k.email_key)
    if (k.linkedin_key) seen.linkedins.add(k.linkedin_key)
    if (k.name_key) seen.names.add(k.name_key)
  })
  return plan
}

export type PasteResult =
  | { ok: true; header: string[]; mapping: ColumnMapping; unmapped: string[]; rows: { raw: Record<string, string>; item: ListItem }[] }
  | { ok: false; error: 'empty' | 'no_rows' | 'too_many_rows' }

/**
 * Rows pasted from a spreadsheet (tab-separated) or a CSV: the first line is
 * the header, mapped like an attached sheet (lib/review/columns.ts); each row
 * keeps its own columns as `raw`.
 */
export function parsePastedRows(text: string): PasteResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim())
  if (!lines.length) return { ok: false, error: 'empty' }
  if (lines.length < 2) return { ok: false, error: 'no_rows' }
  if (lines.length - 1 > PASTE_MAX_ROWS) return { ok: false, error: 'too_many_rows' }
  const split = lines[0].includes('\t') ? (l: string) => l.split('\t').map((c) => c.trim()) : (l: string) => parseCSVRow(l).map((c) => c.trim())
  const header = split(lines[0]).map((h, i) => h || `Column ${i + 1}`)
  const grid = lines.slice(1).map(split)
  const { mapping, unmapped } = leadColumnMapping(header, {}, grid.slice(0, 50))
  const rows = grid.map((cells) => {
    const raw = rowRecord(header, cells)
    return { raw, item: normaliseLead(mappedRecord(raw, mapping)) }
  })
  return { ok: true, header, mapping, unmapped, rows }
}

/** Inline rows from the agent (field → value) as items, normalised like everything else. */
export function inlineItem(row: Partial<Record<EditableField, string>>): ListItem {
  return applyItemEdit(normaliseLead({}), row)
}

const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** One cell edit (or several fields): a blank clears; domain follows the website; name follows company / person unless set. */
export function applyItemEdit(item: ListItem, patch: Partial<Record<EditableField, string | null>>): ListItem {
  const next: ListItem = { ...item }
  for (const f of EDITABLE_FIELDS) if (f in patch) next[f] = clean(patch[f])
  if ('website' in patch) next.domain = domainOf(next.website)
  if (!('name' in patch) && ('company' in patch || 'first_name' in patch || 'last_name' in patch)) {
    next.name = next.company ?? ([next.first_name, next.last_name].filter(Boolean).join(' ') || next.name)
  }
  return next
}

export const listCsvHeader = () => [...LIST_COLUMNS.map((c) => c.label), 'Source'].map(csvCell).join(',')

/** One row of the list CSV (page export and the validator ingest), through the formula-safe cell writer. */
export function listCsvLine(item: ListItem, source: string | null): string {
  return [...LIST_COLUMNS.map((c) => item[c.key] ?? ''), source ?? ''].map((v) => csvCell(v as string)).join(',')
}
