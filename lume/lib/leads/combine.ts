import { domainOf } from '@/lib/apollo/records'
import type { Cells } from '@/lib/leads/columns'
import type { ListItem } from '@/lib/leads/lists/model'

/**
 * Step 2 · Combined (pure): several sheets (lead lists) merged into one master
 * on a key, their columns overlaid.
 *
 *  - Key: `domain` (the row's domain, else its website's, else its email's),
 *    `email`, or `auto` = domain, falling back to email when a row has no
 *    domain. Rows with no key are kept as they are (never merged).
 *  - Overlay: a blank cell is filled from a later row; a filled cell is never
 *    overwritten (`fill_blanks`, the default) unless the owner chose a sheet
 *    to prefer, whose non-blank values win over the others'.
 *  - Duplicates inside one sheet merge the same way.
 *  - Every master row records where it came from (`sources`: sheet + row) and
 *    the cells that disagreed (`conflicts`), for the audit.
 */

export type CombineKey = 'auto' | 'domain' | 'email'
export type OverlayRule = { kind: 'fill_blanks' } | { kind: 'prefer'; sheet_id: string }

export interface CombineSheet {
  id: string
  name: string
  rows: readonly { idx: number; item: ListItem; cells: Cells }[]
}

export interface CombinedRow {
  key: string | null
  item: ListItem
  cells: Cells
  sources: { sheet_id: string; idx: number }[]
  /** Columns where two sheets disagreed (the kept value is in cells). */
  conflicts: string[]
}

export interface CombineResult {
  rows: CombinedRow[]
  /** The master's columns: every sheet's, first-seen order (sheets in the order given). */
  columns: string[]
  stats: {
    input_rows: number
    output_rows: number
    /** Rows folded into an earlier row with the same key. */
    merged: number
    /** Rows with no key (kept unmerged). */
    no_key: number
    /** Master rows where at least one cell disagreed between sheets. */
    rows_with_conflicts: number
  }
}

/** Most rows one combine reads across its sheets. */
export const COMBINE_MAX_INPUT_ROWS = 60_000
export const COMBINE_MAX_SHEETS = 5

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

export function emailOf(item: ListItem): string | null {
  const e = item.email?.trim().toLowerCase() ?? ''
  return EMAIL.test(e) ? e : null
}

/** The row's company domain: its own, else its website's, else its email's (free-mail domains don't count). */
export function rowDomain(item: ListItem): string | null {
  const own = item.domain?.trim().toLowerCase().replace(/^www\./, '') || null
  if (own) return own
  const site = domainOf(item.website)
  if (site) return site
  const email = emailOf(item)
  const d = email ? email.split('@')[1] : null
  return d && !FREE_MAIL.has(d) ? d : null
}

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'msn.com', 'comcast.net'])

export function combineKey(item: ListItem, key: CombineKey): string | null {
  if (key === 'email') return emailOf(item) ? `email:${emailOf(item)}` : null
  const d = rowDomain(item)
  if (d) return `domain:${d}`
  if (key === 'auto') {
    const e = emailOf(item)
    return e ? `email:${e}` : null
  }
  return null
}

/** Overlay `incoming` onto `base` field by field (the helper item and the cells alike). `incomingWins`: its non-blank values replace filled ones. */
function overlay<T extends Record<string, unknown>>(base: T, incoming: T, incomingWins: boolean, locked: Set<string>, conflicts: Set<string>, prefix = ''): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(incoming)) {
    if (blank(v)) continue
    const cur = out[k]
    const id = `${prefix}${k}`
    if (blank(cur)) {
      out[k] = v
      if (incomingWins) locked.add(id)
      continue
    }
    if (String(cur).trim().toLowerCase() === String(v).trim().toLowerCase()) continue
    if (prefix === '') conflicts.add(k)
    if (incomingWins && !locked.has(id)) {
      out[k] = v
      locked.add(id)
    }
  }
  return out as T
}

export function combineSheets(sheets: readonly CombineSheet[], opts: { key?: CombineKey; rule?: OverlayRule } = {}): CombineResult {
  const key = opts.key ?? 'auto'
  const rule = opts.rule ?? { kind: 'fill_blanks' }
  const prefer = rule.kind === 'prefer' ? rule.sheet_id : null
  const out: (CombinedRow & { locked: Set<string>; conflictSet: Set<string> })[] = []
  const byKey = new Map<string, number>()
  const columns: string[] = []
  const seenCols = new Set<string>()
  let input = 0
  let merged = 0
  let noKey = 0
  for (const sheet of sheets) {
    const wins = prefer === sheet.id
    for (const r of sheet.rows) {
      input++
      for (const c of Object.keys(r.cells)) {
        if (!seenCols.has(c)) {
          seenCols.add(c)
          columns.push(c)
        }
      }
      const k = combineKey(r.item, key)
      if (!k) noKey++
      const at = k ? byKey.get(k) : undefined
      if (at === undefined) {
        const locked = new Set<string>()
        if (wins) {
          for (const [f, v] of Object.entries(r.item)) if (!blank(v)) locked.add(`item.${f}`)
          for (const [c, v] of Object.entries(r.cells)) if (!blank(v)) locked.add(c)
        }
        out.push({ key: k, item: { ...r.item }, cells: { ...r.cells }, sources: [{ sheet_id: sheet.id, idx: r.idx }], conflicts: [], locked, conflictSet: new Set() })
        if (k) byKey.set(k, out.length - 1)
        continue
      }
      merged++
      const m = out[at]
      m.cells = overlay(m.cells, r.cells, wins, m.locked, m.conflictSet)
      m.item = overlay(m.item as unknown as Record<string, unknown>, r.item as unknown as Record<string, unknown>, wins, m.locked, m.conflictSet, 'item.') as unknown as ListItem
      m.sources.push({ sheet_id: sheet.id, idx: r.idx })
    }
  }
  const rows: CombinedRow[] = out.map((o) => ({ key: o.key, item: o.item, cells: o.cells, sources: o.sources, conflicts: [...o.conflictSet] }))
  return {
    rows,
    columns,
    stats: { input_rows: input, output_rows: rows.length, merged, no_key: noKey, rows_with_conflicts: rows.filter((r) => r.conflicts.length > 0).length },
  }
}
