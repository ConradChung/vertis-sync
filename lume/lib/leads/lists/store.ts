import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { Json } from '@/lib/db/types'
import {
  applyItemEdit,
  dedupeKeys,
  LIST_MAX_ITEMS,
  listCsvHeader,
  listCsvLine,
  planAppend,
  type EditableField,
  type ItemSource,
  type ListItem,
} from '@/lib/leads/lists/model'

/**
 * Lead lists in Supabase: lead_review_sets rows with kind = 'list' and their
 * lead_review_items (service role; owner-only routes in front). Nothing here
 * holds a whole list in memory: appends dedupe chunk by chunk with indexed
 * key lookups, reads and the CSV page through the rows, counts are head-only.
 */

export interface LeadList {
  id: string
  name: string
  notes: string | null
  created_by: 'agent' | 'owner' | null
  project_id: string | null
  project_default: boolean
  item_count: number
  email_count: number
  sent_ingest_id: string | null
  sent_at: string | null
  sent_rows: number | null
  created_at: string
  updated_at: string
}

export interface ListRow {
  idx: number
  item: ListItem
  source: ItemSource | null
}

export interface IncomingRow {
  raw: Record<string, unknown> | null
  item: ListItem
  source: ItemSource
}

export interface AppendResult {
  added: number
  duplicates: number
  skipped: number
  over_cap: number
  item_count: number
}

const db = () => createServiceClient()
const COLS = 'id,title,notes,created_by,project_id,project_default,item_count,email_count,sent_ingest_id,sent_at,sent_rows,created_at,updated_at'
const CHUNK = 500

type SetRow = Omit<LeadList, 'name'> & { title: string }
const toList = (r: SetRow): LeadList => {
  const { title, ...rest } = r
  return { ...rest, name: title, project_default: !!rest.project_default, item_count: rest.item_count ?? 0, email_count: rest.email_count ?? 0 }
}
const lists = () => db().from('lead_review_sets')
const items = () => db().from('lead_review_items')
const now = () => new Date().toISOString()

export async function createList(input: { name: string; notes?: string | null; created_by: 'agent' | 'owner'; project_id?: string | null; project_default?: boolean }): Promise<LeadList> {
  const { data, error } = await lists()
    .insert({
      kind: 'list',
      title: input.name.trim().slice(0, 200),
      notes: input.notes?.trim() || null,
      created_by: input.created_by,
      source_kind: 'list',
      source_id: 'list',
      project_id: input.project_id ?? null,
      project_default: !!input.project_default,
      item_count: 0,
      email_count: 0,
      filters: [],
      created_at: now(),
      updated_at: now(),
      archived_at: null,
    })
    .select(COLS)
    .single()
  if (error) throw error
  return toList(data as unknown as SetRow)
}

export async function getList(id: string): Promise<LeadList | null> {
  const { data, error } = await lists().select(COLS).eq('id', id).eq('kind', 'list').is('archived_at', null).maybeSingle()
  if (error) throw error
  return data ? toList(data as unknown as SetRow) : null
}

/** Every live list, most recently changed first. */
export async function listLists(limit = 500): Promise<LeadList[]> {
  const { data, error } = await lists().select(COLS).eq('kind', 'list').is('archived_at', null).order('updated_at', { ascending: false }).limit(limit)
  if (error) throw error
  return ((data ?? []) as unknown as SetRow[]).map(toList)
}

export async function updateList(id: string, patch: { name?: string; notes?: string | null }): Promise<LeadList | null> {
  const row: Record<string, unknown> = { updated_at: now() }
  if (patch.name !== undefined) row.title = patch.name.trim().slice(0, 200)
  if (patch.notes !== undefined) row.notes = patch.notes?.trim() || null
  const { error } = await lists().update(row).eq('id', id).eq('kind', 'list')
  if (error) throw error
  return getList(id)
}

/** Into a folder (a project) or Unfiled (null). A list moved out of its project stops being that project's default. */
export async function moveList(id: string, projectId: string | null): Promise<LeadList | null> {
  const { error } = await lists().update({ project_id: projectId, project_default: false, updated_at: now() }).eq('id', id).eq('kind', 'list')
  if (error) throw error
  return getList(id)
}

/** Hard delete (the items cascade). */
export async function deleteList(id: string): Promise<boolean> {
  const { data, error } = await lists().delete().eq('id', id).eq('kind', 'list').select('id')
  if (error) throw error
  return (data ?? []).length > 0
}

/** The project's auto-append list, created the first time (named after the project). */
export async function projectDefaultList(projectId: string, projectName: string): Promise<LeadList> {
  const find = async () => {
    const { data, error } = await lists().select(COLS).eq('kind', 'list').eq('project_id', projectId).eq('project_default', true).is('archived_at', null).maybeSingle()
    if (error) throw error
    return data ? toList(data as unknown as SetRow) : null
  }
  const hit = await find()
  if (hit) return hit
  try {
    return await createList({ name: projectName, created_by: 'agent', project_id: projectId, project_default: true })
  } catch (err) {
    // Two appends raced to create it (lead_lists_project_default_idx): use the winner's.
    const again = await find()
    if (again) return again
    throw err
  }
}

/** item_count, email_count and updated_at from head-only counts. */
export async function recount(listId: string): Promise<{ item_count: number; email_count: number }> {
  const all = await items().select('id', { count: 'exact', head: true }).eq('set_id', listId)
  if (all.error) throw all.error
  const withEmail = await items().select('id', { count: 'exact', head: true }).eq('set_id', listId).not('email_key', 'is', null)
  if (withEmail.error) throw withEmail.error
  const counts = { item_count: all.count ?? 0, email_count: withEmail.count ?? 0 }
  const { error } = await lists().update({ ...counts, updated_at: now() }).eq('id', listId)
  if (error) throw error
  return counts
}

async function nextIdx(listId: string): Promise<number> {
  const { data, error } = await items().select('idx').eq('set_id', listId).order('idx', { ascending: false }).limit(1)
  if (error) throw error
  const top = (data ?? [])[0] as { idx: number } | undefined
  return top ? top.idx + 1 : 0
}

async function existingKeys(listId: string, column: 'email_key' | 'linkedin_key' | 'name_key', values: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  const unique = [...new Set(values)]
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await items().select(column).eq('set_id', listId).in(column, unique.slice(i, i + 200))
    if (error) throw error
    for (const r of (data ?? []) as Record<string, string>[]) out.add(r[column])
  }
  return out
}

/**
 * Append with dedupe (email, then LinkedIn, then name + company/domain)
 * against the list and within the batch, CHUNK rows at a time, up to the
 * list's cap.
 */
export async function appendItems(listId: string, rows: readonly IncomingRow[], opts: { max?: number } = {}): Promise<AppendResult> {
  const max = opts.max ?? LIST_MAX_ITEMS
  const first = await recount(listId)
  let count = first.item_count
  let idx = await nextIdx(listId)
  const out: AppendResult = { added: 0, duplicates: 0, skipped: 0, over_cap: 0, item_count: count }
  // Keys added by earlier chunks of this call, so a duplicate across chunks is caught without re-reading.
  const added = { emails: new Set<string>(), linkedins: new Set<string>(), names: new Set<string>() }
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const keys = chunk.map((r) => dedupeKeys(r.item))
    const pick = (k: keyof (typeof keys)[number]) => keys.map((x) => x[k]).filter((v): v is string => !!v)
    const [emails, linkedins, names] = await Promise.all([
      existingKeys(listId, 'email_key', pick('email_key')),
      existingKeys(listId, 'linkedin_key', pick('linkedin_key')),
      existingKeys(listId, 'name_key', pick('name_key')),
    ])
    for (const e of added.emails) emails.add(e)
    for (const l of added.linkedins) linkedins.add(l)
    for (const n of added.names) names.add(n)
    const plan = planAppend({ emails, linkedins, names }, chunk.map((r) => r.item), Math.max(0, max - count))
    out.duplicates += plan.duplicates
    out.skipped += plan.skipped
    out.over_cap += plan.over_cap
    if (!plan.add.length) continue
    const batch = plan.add.map((j) => {
      const k = keys[j]
      if (k.email_key) added.emails.add(k.email_key)
      if (k.linkedin_key) added.linkedins.add(k.linkedin_key)
      if (k.name_key) added.names.add(k.name_key)
      return { set_id: listId, idx: idx++, item: chunk[j].item as unknown as Json, raw: (chunk[j].raw ?? null) as Json, status: 'kept', source: chunk[j].source, ...k }
    })
    const { error } = await items().insert(batch)
    if (error) throw error
    out.added += batch.length
    count += batch.length
  }
  out.item_count = (await recount(listId)).item_count
  return out
}

export type SortField = EditableField | 'idx'

/** One page of rows; `q` searches name, company, email, title, city; sort by a field or the row order. */
export async function pageItems(
  listId: string,
  opts: { page?: number; pageSize?: number; q?: string; sort?: SortField; dir?: 'asc' | 'desc' } = {}
): Promise<{ rows: ListRow[]; total: number }> {
  const page = Math.max(0, opts.page ?? 0)
  const size = Math.min(500, Math.max(1, opts.pageSize ?? 50))
  let q = items().select('idx,item,source', { count: 'exact' }).eq('set_id', listId)
  const term = opts.q?.trim().replace(/[%,()*\\]/g, ' ').trim()
  if (term) q = q.or(['name', 'first_name', 'last_name', 'company', 'email', 'title', 'city', 'domain'].map((f) => `item->>${f}.ilike.%${term}%`).join(','))
  const sort = !opts.sort || opts.sort === 'idx' ? 'idx' : `item->>${opts.sort}`
  q = q.order(sort, { ascending: opts.dir !== 'desc' })
  if (sort !== 'idx') q = q.order('idx', { ascending: true })
  const { data, error, count } = await q.range(page * size, page * size + size - 1)
  if (error) throw error
  return { rows: (data ?? []) as unknown as ListRow[], total: count ?? 0 }
}

/** Edit fields of one row; its dedupe keys and the list's email count follow. null when the row is not there. */
export async function updateItem(listId: string, idx: number, patch: Partial<Record<EditableField, string | null>>): Promise<ListRow | null> {
  const { data, error } = await items().select('idx,item,source').eq('set_id', listId).eq('idx', idx).maybeSingle()
  if (error) throw error
  if (!data) return null
  const item = applyItemEdit((data as unknown as ListRow).item, patch)
  const up = await items().update({ item: item as unknown as Json, ...dedupeKeys(item) }).eq('set_id', listId).eq('idx', idx)
  if (up.error) throw up.error
  await recount(listId)
  return { idx, item, source: (data as unknown as ListRow).source }
}

export async function deleteItems(listId: string, idxs: readonly number[]): Promise<number> {
  let removed = 0
  for (let i = 0; i < idxs.length; i += CHUNK) {
    const { data, error } = await items().delete().eq('set_id', listId).in('idx', idxs.slice(i, i + CHUNK)).select('idx')
    if (error) throw error
    removed += (data ?? []).length
  }
  if (idxs.length) await recount(listId)
  return removed
}

export const MISSING = ['email', 'linkedin', 'phone', 'website'] as const

/** Remove rows lacking any of these fields, or matching a search. Returns how many went. */
export async function removeWhere(listId: string, f: { missing?: (typeof MISSING)[number][]; q?: string }): Promise<number> {
  let removed = 0
  for (const m of f.missing ?? []) {
    const col = m === 'email' ? 'email_key' : m === 'linkedin' ? 'linkedin_key' : `item->>${m}`
    const { data, error } = await items().delete().eq('set_id', listId).is(col, null).select('idx')
    if (error) throw error
    removed += (data ?? []).length
  }
  const term = f.q?.trim().replace(/[%,()*\\]/g, ' ').trim()
  if (term) {
    const { data, error } = await items()
      .delete()
      .eq('set_id', listId)
      .or(['name', 'first_name', 'last_name', 'company', 'email', 'title', 'city', 'domain'].map((x) => `item->>${x}.ilike.%${term}%`).join(','))
      .select('idx')
    if (error) throw error
    removed += (data ?? []).length
  }
  await recount(listId)
  return removed
}

/** The list as CSV, `pageSize` rows at a time: the header, then one chunk per page. */
export async function* csvChunks(listId: string, pageSize = 1000): AsyncGenerator<string> {
  yield listCsvHeader() + '\n'
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await items().select('idx,item,source').eq('set_id', listId).order('idx', { ascending: true }).range(from, from + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as unknown as ListRow[]
    if (page.length) yield page.map((r) => listCsvLine(r.item, r.source)).join('\n') + '\n'
    if (page.length < pageSize) return
  }
}

/** Rows that carry an email, in order, as CSV lines (the validator ingest), plus how many. */
export async function emailCsv(listId: string, pageSize = 1000): Promise<{ csv: string; rows: number }> {
  const parts: string[] = [listCsvHeader()]
  let rows = 0
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await items().select('idx,item,source').eq('set_id', listId).not('email_key', 'is', null).order('idx', { ascending: true }).range(from, from + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as unknown as ListRow[]
    for (const r of page) parts.push(listCsvLine(r.item, r.source))
    rows += page.length
    if (page.length < pageSize) break
  }
  return { csv: parts.join('\n') + '\n', rows }
}

export async function markSent(listId: string, ingestId: string, rows: number): Promise<void> {
  const { error } = await lists().update({ sent_ingest_id: ingestId, sent_at: now(), sent_rows: rows }).eq('id', listId)
  if (error) throw error
}
