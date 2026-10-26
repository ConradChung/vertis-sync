import 'server-only'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import type { Json } from '@/lib/db/types'
import type { ApolloSource } from '@/lib/apollo/records'
import { loadSourceRows } from '@/lib/apollo/source'
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
  source_kind: ApolloSource['kind']
  source_id: string
  source_conversation_id: string | null
  item_count: number
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
const SET_COLS = 'id,title,source_kind,source_id,source_conversation_id,item_count,filters,created_at,updated_at'

export async function createReviewSet(source: ApolloSource, opts: { conversationId?: string | null; title?: string } = {}) {
  const { rows, label } = await loadSourceRows(source)
  const capped = rows.slice(0, REVIEW_MAX_ITEMS)
  const sb = db()
  const { data: set, error } = await sb
    .from('lead_review_sets')
    .insert({
      title: opts.title?.trim() || label,
      source_kind: source.kind,
      source_id: source.id,
      source_conversation_id: opts.conversationId ?? null,
      item_count: capped.length,
    })
    .select(SET_COLS)
    .single()
  if (error) throw error
  for (let i = 0; i < capped.length; i += 500) {
    const batch = capped.slice(i, i + 500).map((raw, k) => ({
      set_id: set.id,
      idx: i + k,
      item: normaliseLead(raw) as unknown as Json,
      raw: raw as Json,
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
  const { data, error } = await db().from('lead_review_sets').select(SET_COLS).eq('id', id).is('archived_at', null).maybeSingle()
  if (error) throw error
  return (data as ReviewSet | null) ?? null
}

export async function listReviewSets(conversationId?: string | null, limit = 20): Promise<ReviewSet[]> {
  let q = db().from('lead_review_sets').select(SET_COLS).is('archived_at', null).order('created_at', { ascending: false }).limit(limit)
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
      .select('idx,item,status,excluded_reason,filter_id')
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
