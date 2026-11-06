import { csvCell } from '@/lib/csv/cell'
import { detectedEmailColumn, normalizeHeader } from '@/lib/import/csv'
import { applyItemEdit, EDITABLE_FIELDS, LIST_COLUMNS, type EditableField, type ListItem } from '@/lib/leads/lists/model'
import { leadColumnMapping } from '@/lib/review/columns'

/**
 * The columns a lead set or list shows (pure): the source's own fields, not
 * Lume's mapped ones. An Apify item is flattened in its own key order (nested
 * objects as `a.b`, arrays of values joined, arrays of objects as JSON); a
 * set's columns are the union in first-seen order, capped. The mapped
 * `item` stays alongside as the hidden helper (filters, dedupe, the
 * validator's email column).
 */

export const MAX_COLUMNS = 100
const MAX_DEPTH = 3
const MAX_CELL = 5000

export type Cells = Record<string, string>

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const scalar = (v: unknown) => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
const cap = (s: string) => (s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s)

export function flattenRecord(obj: Record<string, unknown>, prefix = '', depth = 1, out: Cells = {}): Cells {
  for (const [k, v] of Object.entries(obj)) {
    const key = `${prefix}${k}`
    if (isPlain(v)) {
      if (depth < MAX_DEPTH) flattenRecord(v, `${key}.`, depth + 1, out)
      else out[key] = cap(JSON.stringify(v))
    } else if (Array.isArray(v)) {
      out[key] = cap(v.every(scalar) ? v.filter((x) => x !== null && x !== undefined && x !== '').map(String).join('; ') : JSON.stringify(v))
    } else {
      out[key] = v === null || v === undefined ? '' : cap(String(v))
    }
  }
  return out
}

/** `existing`, then every new key of `rows` in first-seen order, up to MAX_COLUMNS. */
export function mergeColumns(existing: readonly string[], rows: readonly Cells[], max = MAX_COLUMNS): string[] {
  const out = [...existing]
  const seen = new Set(out)
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (out.length >= max) return out
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  return out
}

/** Only the given columns (the set's visible ones) of a row. */
export function pickCells(cells: Cells, columns: readonly string[]): Cells {
  const keep = new Set(columns)
  return Object.fromEntries(Object.entries(cells).filter(([k]) => keep.has(k)))
}

/** A lead the agent or the owner wrote: its fields under readable labels (Name, Email, …). */
export function labelCells(item: ListItem): Cells {
  const out: Cells = {}
  for (const c of LIST_COLUMNS) if (item[c.key]) out[c.label] = String(item[c.key])
  return out
}

/**
 * One cell edit: the cell changes, and a helper field that showed the old
 * value follows it, so dedupe keys and the validator's email stay right.
 */
export function editCell(cells: Cells, item: ListItem, column: string, value: string): { cells: Cells; item: ListItem } {
  const old = (cells[column] ?? '').trim()
  const next = { ...cells, [column]: value.trim() }
  const patch: Partial<Record<EditableField, string>> = {}
  if (old) for (const f of EDITABLE_FIELDS) if ((item[f] ?? '').toString().trim() === old) patch[f] = value
  // A labelled column (agent / owner rows), or a header that names a field
  // (Email, LinkedIn, Company…), maps straight onto that field.
  const labelled = LIST_COLUMNS.find((c) => c.label === column)
  if (labelled) patch[labelled.key] = value
  for (const field of Object.keys(leadColumnMapping([column]).mapping)) {
    const f = (field === 'full_name' ? 'name' : field) as EditableField
    if ((EDITABLE_FIELDS as readonly string[]).includes(f)) patch[f] = value
  }
  return { cells: next, item: Object.keys(patch).length ? applyItemEdit(item, patch) : item }
}

const emailish = (h: string) => {
  const n = normalizeHeader(h)
  return !n.includes('personal') && (n.includes('email') || n.includes('mail'))
}

/**
 * The validator CSV's header: the source columns when exactly one email
 * column is detected; otherwise an `Email` column (from the helper) is added
 * and any clashing email-like columns are renamed `… (source)`, so the
 * ingest gate's detection finds exactly one.
 */
export function sendHeader(columns: readonly string[]): { header: string[]; emailColumn: string; added: boolean } {
  const det = detectedEmailColumn([...columns])
  if (det) return { header: [...columns], emailColumn: det, added: false }
  return { header: [...columns.map((c) => (emailish(c) ? `${c} (source)` : c)), 'Email'], emailColumn: 'Email', added: true }
}

export const cellsCsvHeader = (columns: readonly string[]) => columns.map(csvCell).join(',')

/** One row in column order (blank where the row lacks a column), formula-safe. */
export function cellsCsvLine(cells: Cells, columns: readonly string[]): string {
  return columns.map((c) => csvCell(cells[c] ?? '')).join(',')
}
