import { csvCell } from '@/lib/csv/cell'
import { detectedEmailColumn, normalizeHeader } from '@/lib/import/csv'
import { applyItemEdit, EDITABLE_FIELDS, LIST_COLUMNS, type EditableField, type ListItem } from '@/lib/leads/lists/model'
import { leadColumnMapping } from '@/lib/review/columns'
import { clip } from '@/lib/text/wellFormed'

/**
 * The columns a lead set or list shows (pure): the source's own fields, not
 * Lume's mapped ones. An Apify item is flattened in its own key order (nested
 * objects as `a.b`, arrays of values joined, arrays of objects as JSON); a
 * set's columns are the union in first-seen order, capped. The mapped
 * `item` stays alongside as the hidden helper (filters, dedupe, the
 * validator's email column).
 */

/** Columns shown (the table, the CSV). */
export const MAX_COLUMNS = 100
/** Keys stored per row (cells) and listed as the set's all_columns: a safety cap, far above any actor seen. */
export const MAX_CELL_KEYS = 300
const MAX_DEPTH = 3
const MAX_CELL = 5000

export type Cells = Record<string, string>

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const scalar = (v: unknown) => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
const cap = (s: string) => clip(s, MAX_CELL)

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

/**
 * Column statistics gathered row by row (so a set can be read page by page):
 * first-seen key order and fill counts per row type (an actor's `type`).
 */
export class ColumnStats {
  private order: string[] = []
  private seen = new Set<string>()
  private byType = new Map<string, Map<string, number>>()

  add(row: Cells): void {
    const t = row.type ?? ''
    const fill = this.byType.get(t) ?? new Map<string, number>()
    for (const [k, v] of Object.entries(row)) {
      if (!this.seen.has(k)) {
        this.seen.add(k)
        this.order.push(k)
      }
      if (v !== '') fill.set(k, (fill.get(k) ?? 0) + 1)
    }
    this.byType.set(t, fill)
  }

  /** Every key in first-seen order, up to `max`. */
  all(max = MAX_CELL_KEYS): string[] {
    return this.order.slice(0, max)
  }

  /**
   * The columns to show when there are more than `max`: rank keys by how
   * often they are filled within each row type and take the best of each
   * type in turn, so one type's many fields cannot crowd out another's.
   * Only keys within `among` (the stored ones); shown in first-seen order.
   */
  choose(max = MAX_COLUMNS, among: readonly string[] = this.order): string[] {
    const allowed = new Set(among)
    const all = this.order.filter((k) => allowed.has(k))
    if (all.length <= max) return all
    const queues = [...this.byType.values()].map((fill) =>
      [...fill.entries()]
        .filter(([k]) => allowed.has(k))
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k)
    )
    const chosen = new Set<string>()
    while (chosen.size < max && queues.some((q) => q.length)) {
      for (const q of queues) {
        while (q.length && chosen.has(q[0])) q.shift()
        const k = q.shift()
        if (k !== undefined) chosen.add(k)
        if (chosen.size >= max) break
      }
    }
    return all.filter((k) => chosen.has(k))
  }
}

/** chooseColumns over rows in hand (see ColumnStats.choose). */
export function chooseColumns(rows: readonly Cells[], max = MAX_COLUMNS): string[] {
  const stats = new ColumnStats()
  for (const r of rows) stats.add(r)
  return stats.choose(max)
}
