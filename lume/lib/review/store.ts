import 'server-only'
import { deepWellFormed } from '@/lib/text/wellFormed'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import type { Json } from '@/lib/db/types'
import type { ApolloSource } from '@/lib/apollo/records'
import { loadSourceRows } from '@/lib/apollo/source'
import { chooseColumns, ColumnStats, flattenRecord, MAX_CELL_KEYS, MAX_COLUMNS, mergeColumns, pickCells } from '@/lib/leads/columns'
import {
  describeCriteria,
  normaliseLead,
  planFilter,
  REVIEW_MAX_ITEMS,
  summarise,
  type FilterAction,
  type FilterCriteria,
  type LeadItem,
  type ReviewRow,
} from '@/lib/review/model'

/** Supabase storage for lead review sets (service role; owner-only routes in front). */

export interface ReviewSet {
  id: string
  title: string
  source_kind: ApolloSource['kind'] | 'attachment'
  source_id: string
  source_conversation_id: string | null
  item_count: number
  /** The visible columns: the source's own fields (an actor's output keys, a sheet's headers), first-seen order, ≤ 100. */
  columns: string[]
  /** Every stored column (≤ 300), what summaries may use. */
  all_columns: string[]
  /** When a backfill of cells from raw was attempted (sets loaded before cells existed). */
  cells_backfilled_at?: string | null
  filters: AppliedFilter[]
  created_at: string
  updated_at: string
}

export interface AppliedFilter {
  id: string
  action: FilterAction | 'manual'
  criteria: FilterCriteria | null
  label: string
  reason: string | null
  changed: number
  at: string
  undone?: boolean
}

const db = () => createServiceClient()
const SET_COLS = 'id,title,source_kind,source_id,source_conversation_id,item_count,columns,all_columns,cells_backfilled_at,filters,created_at,updated_at'

export async function createReviewSet(source: ApolloSource, opts: { conversationId?: string | null; title?: string } = {}) {
  const { rows, label, item_count } = await loadSourceRows(source)
  const made = await createReviewSetFromRows({ kind: source.kind, id: source.id, label, rows }, opts)
  // Apify's own count beats the loaded rows (a dataset can be larger than what was fetched).
  const total = Math.max(item_count ?? 0, made.source_rows)
  return { ...made, source_rows: total, truncated: made.truncated || total > made.set.item_count }
}

/**
 * A review set from rows already in hand (an attached spreadsheet's sheet).
 * `normalisable(raw)` is the record normaliseLead reads (the sheet's mapped
 * columns); `raw` is stored as-is, every original column kept.
 */
export async function createReviewSetFromRows(
  source: { kind: ReviewSet['source_kind']; id: string; label: string; rows: Record<string, unknown>[]; normalisable?: (raw: Record<string, unknown>) => Record<string, unknown> },
  opts: { conversationId?: string | null; title?: string } = {}
) {
  const { rows, label } = source
  const capped = rows.slice(0, REVIEW_MAX_ITEMS)
  // Each row's own fields, flattened (all kept, ≤ 300 keys); the panel shows ≤ 100 chosen by fill rate across row types.
  const flat = capped.map((raw) => flattenRecord(raw))
  const all_columns = mergeColumns([], flat, MAX_CELL_KEYS)
  const cells = flat.map((c) => pickCells(c, all_columns))
  const columns = chooseColumns(cells)
  const sb = db()
  const { data: set, error } = await sb
    .from('lead_review_sets')
    .insert({
      title: opts.title?.trim() || label,
      source_kind: source.kind,
      source_id: source.id,
      source_conversation_id: opts.conversationId ?? null,
      item_count: capped.length,
      columns,
      all_columns,
    })
    .select(SET_COLS)
    .single()
  if (error) throw error
  for (let i = 0; i < capped.length; i += 500) {
    const batch = capped.slice(i, i + 500).map((raw, k) => ({
      set_id: set.id,
      idx: i + k,
      item: deepWellFormed(normaliseLead(source.normalisable ? source.normalisable(raw) : raw)) as unknown as Json,
      raw: deepWellFormed(raw) as Json,
      cells: deepWellFormed(cells[i + k]) as Json,
    }))
    const { error: e } = await sb.from('lead_review_items').insert(batch)
    if (e) {
      await sb.from('lead_review_sets').delete().eq('id', set.id)
      throw e
    }
  }
  return { set: set as ReviewSet, truncated: rows.length > capped.length, source_rows: rows.length }
}

export async function getReviewSet(id: string): Promise<ReviewSet | null> {
  // Lead lists (kind 'list') live in the same table; they have their own routes (lib/leads/lists).
  const { data, error } = await db().from('lead_review_sets').select(SET_COLS).eq('id', id).neq('kind', 'list').is('archived_at', null).maybeSingle()
  if (error) throw error
  return (data as ReviewSet | null) ?? null
}

export async function listReviewSets(conversationId?: string | null, limit = 20): Promise<ReviewSet[]> {
  let q = db().from('lead_review_sets').select(SET_COLS).neq('kind', 'list').is('archived_at', null).order('created_at', { ascending: false }).limit(limit)
  if (conversationId) q = q.eq('source_conversation_id', conversationId)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as ReviewSet[]
}

/** Every row of a set (≤ 5 000), idx order. */
export async function loadRows(setId: string): Promise<ReviewRow[]> {
  const out: ReviewRow[] = []
  for (let from = 0; from < REVIEW_MAX_ITEMS; from += 1000) {
    const { data, error } = await db()
      .from('lead_review_items')
      .select('idx,item,cells,status,excluded_reason,filter_id')
      .eq('set_id', setId)
      .order('idx')
      .range(from, from + 999)
    if (error) throw error
    for (const r of data ?? []) out.push({ ...r, item: r.item as unknown as LeadItem } as ReviewRow)
    if (!data || data.length < 1000) break
  }
  return out
}

async function setStatus(setId: string, idxs: number[], patch: { status: 'kept' | 'excluded'; excluded_reason: string | null; filter_id: string | null }) {
  for (let i = 0; i < idxs.length; i += 500) {
    const { error } = await db().from('lead_review_items').update(patch).eq('set_id', setId).in('idx', idxs.slice(i, i + 500))
    if (error) throw error
  }
}

async function saveFilters(setId: string, filters: AppliedFilter[]) {
  const { error } = await db()
    .from('lead_review_sets')
    .update({ filters: filters as unknown as Json, updated_at: new Date().toISOString() })
    .eq('id', setId)
  if (error) throw error
}

export async function applyFilter(set: ReviewSet, criteria: FilterCriteria, action: FilterAction, reason: string | null) {
  const rows = await loadRows(set.id)
  const before = summarise(rows)
  const idxs = planFilter(rows, criteria, action)
  const filter: AppliedFilter = {
    id: randomUUID().slice(0, 8),
    action,
    criteria,
    label: describeCriteria(criteria, action),
    reason,
    changed: idxs.length,
    at: new Date().toISOString(),
  }
  if (idxs.length) {
    await setStatus(set.id, idxs, { status: 'excluded', excluded_reason: reason ?? filter.label, filter_id: filter.id })
    await saveFilters(set.id, [...set.filters, filter])
  }
  const changed = new Set(idxs)
  const after = summarise(rows.map((r) => (changed.has(r.idx) ? { ...r, status: 'excluded' as const } : r)))
  return { filter, before: { kept: before.kept, excluded: before.excluded }, after, sample: rows.filter((r) => changed.has(r.idx)).slice(0, 8).map((r) => ({ idx: r.idx, name: r.item.name, category: r.item.category, city: r.item.city })) }
}

/** Hand edits from the Leads table: exclude or restore specific rows. */
export async function setRowsByHand(set: ReviewSet, idxs: number[], status: 'kept' | 'excluded') {
  if (!idxs.length) return { changed: 0 }
  const id = randomUUID().slice(0, 8)
  await setStatus(set.id, idxs, status === 'excluded' ? { status, excluded_reason: 'Excluded by hand', filter_id: id } : { status, excluded_reason: null, filter_id: null })
  if (status === 'excluded') {
    await saveFilters(set.id, [
      ...set.filters,
      { id, action: 'manual', criteria: null, label: `Excluded ${idxs.length} row${idxs.length === 1 ? '' : 's'} by hand`, reason: null, changed: idxs.length, at: new Date().toISOString() },
    ])
  }
  return { changed: idxs.length }
}

/** Undo: one filter's exclusions, explicit rows, or everything. */
export async function restore(set: ReviewSet, what: { filter_id?: string; item_ids?: number[]; all?: boolean }) {
  const rows = await loadRows(set.id)
  const idxs = rows
    .filter((r) => r.status === 'excluded')
    .filter((r) => (what.all ? true : what.filter_id ? r.filter_id === what.filter_id : (what.item_ids ?? []).includes(r.idx)))
    .map((r) => r.idx)
  if (idxs.length) await setStatus(set.id, idxs, { status: 'kept', excluded_reason: null, filter_id: null })
  const filters = set.filters.map((f) => (what.all || (what.filter_id && f.id === what.filter_id) ? { ...f, undone: true } : f))
  await saveFilters(set.id, filters)
  const changed = new Set(idxs)
  return { restored: idxs.length, after: summarise(rows.map((r) => (changed.has(r.idx) ? { ...r, status: 'kept' as const } : r))) }
}

/**
 * Sets loaded before cells were stored: flatten each raw row and store its
 * cells, page by page (never the whole set in memory), writing ONLY the cells
 * column (lume_set_lead_cells) so a concurrent filter is never reverted. The
 * attempt is stamped (cells_backfilled_at): a set whose rows have no raw is
 * not re-scanned on the next read.
 */
export async function ensureCells(set: ReviewSet, opts: { pageSize?: number } = {}): Promise<ReviewSet> {
  if (set.cells_backfilled_at || (set.all_columns ?? []).length || !set.item_count) return set
  const sb = db()
  const pageSize = opts.pageSize ?? 1000
  const stats = new ColumnStats()
  for (let from = 0; from < REVIEW_MAX_ITEMS; from += pageSize) {
    const { data, error } = await sb.from('lead_review_items').select('idx,raw').eq('set_id', set.id).order('idx').range(from, from + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as { idx: number; raw: Record<string, unknown> | null }[]
    const rows: { idx: number; cells: Record<string, string> }[] = []
    for (const r of page) {
      if (!r.raw) continue
      const flat = flattenRecord(r.raw)
      stats.add(flat)
      rows.push({ idx: r.idx, cells: pickCells(flat, stats.all(MAX_CELL_KEYS)) })
    }
    if (rows.length) {
      const res = await sb.rpc('lume_set_lead_cells', { p_set: set.id, p_rows: rows })
      if (res.error) throw res.error
    }
    if (page.length < pageSize) break
  }
  const all_columns = stats.all(MAX_CELL_KEYS)
  const columns = stats.choose(MAX_COLUMNS, all_columns)
  const cells_backfilled_at = new Date().toISOString()
  const { error } = await sb.from('lead_review_sets').update({ columns, all_columns, cells_backfilled_at }).eq('id', set.id)
  if (error) throw error
  return { ...set, columns, all_columns, cells_backfilled_at }
}
