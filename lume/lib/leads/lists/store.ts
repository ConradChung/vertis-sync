import 'server-only'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import type { Json } from '@/lib/db/types'
import {
  applyItemEdit,
  dedupeKeys,
  LIST_COLUMNS,
  LIST_MAX_ITEMS,
  planAppend,
  type EditableField,
  type ItemSource,
  type ListItem,
} from '@/lib/leads/lists/model'
import { cellsCsvHeader, cellsCsvLine, editCell, labelCells, mergeColumns, pickCells, sendHeader, type Cells } from '@/lib/leads/columns'

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
  /** The visible columns: the sources' own fields, in first-seen order (≤ 100). */
  columns: string[]
  /** Moves only when rows are added, removed or edited; the resend guard compares sent_at with it. */
  content_changed_at: string
  created_at: string
  updated_at: string
}

export interface ListRow {
  idx: number
  item: ListItem
  /** The row's values by column (blank where it lacks one). */
  cells: Cells
  source: ItemSource | null
}

export interface IncomingRow {
  raw: Record<string, unknown> | null
  item: ListItem
  source: ItemSource
  cells: Cells
}

export interface AppendResult {
  added: number
  duplicates: number
  skipped: number
  over_cap: number
  item_count: number
}

const db = () => createServiceClient()
const COLS = 'id,title,notes,created_by,project_id,project_default,item_count,email_count,sent_ingest_id,sent_at,sent_rows,columns,content_changed_at,created_at,updated_at'
const CHUNK = 500

type SetRow = Omit<LeadList, 'name'> & { title: string }
const toList = (r: SetRow): LeadList => {
  const { title, ...rest } = r
  return { ...rest, name: title, project_default: !!rest.project_default, item_count: rest.item_count ?? 0, email_count: rest.email_count ?? 0, columns: Array.isArray(rest.columns) ? rest.columns : [] }
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
      columns: [],
      filters: [],
      created_at: now(),
      updated_at: now(),
      content_changed_at: now(),
      append_lease_token: null,
      append_lease_until: null,
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

/**
 * item_count and email_count from head-only counts. `changed` (rows were
 * actually added, removed or edited) also moves updated_at and
 * content_changed_at — never a bare recount, or an unchanged list could be
 * sent again.
 */
export async function recount(listId: string, changed = false): Promise<{ item_count: number; email_count: number }> {
  const all = await items().select('id', { count: 'exact', head: true }).eq('set_id', listId)
  if (all.error) throw all.error
  const withEmail = await items().select('id', { count: 'exact', head: true }).eq('set_id', listId).not('email_key', 'is', null)
  if (withEmail.error) throw withEmail.error
  const counts = { item_count: all.count ?? 0, email_count: withEmail.count ?? 0 }
  const stamp = now()
  const { error } = await lists().update({ ...counts, ...(changed ? { updated_at: stamp, content_changed_at: stamp } : {}) }).eq('id', listId)
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
export async function appendItems(
  listId: string,
  rows: readonly IncomingRow[],
  opts: { max?: number; wait?: () => Promise<void>; attempts?: number } = {}
): Promise<AppendResult> {
  const token = await claimAppendLease(listId, opts)
  try {
    return await appendLocked(listId, rows, opts.max ?? LIST_MAX_ITEMS)
  } finally {
    await lists().update({ append_lease_token: null, append_lease_until: null }).eq('id', listId).eq('append_lease_token', token)
  }
}

/** How long one append may hold a list (the routes' maxDuration is 120 s). */
const APPEND_LEASE_MS = 150_000

export class ListBusy extends Error {
  constructor() {
    super('list_busy')
    this.name = 'ListBusy'
  }
}

/**
 * Appends to one list run one at a time: a conditional UPDATE claims the
 * set row's lease (free, or expired after a crash); a caller that finds it
 * held waits and retries, then gives up as ListBusy.
 */
async function claimAppendLease(listId: string, opts: { wait?: () => Promise<void>; attempts?: number }): Promise<string> {
  const token = randomUUID()
  const wait = opts.wait ?? (() => new Promise<void>((r) => setTimeout(r, 500)))
  for (let attempt = 0; attempt < (opts.attempts ?? 60); attempt++) {
    const until = new Date(Date.now() + APPEND_LEASE_MS).toISOString()
    const free = await lists().update({ append_lease_token: token, append_lease_until: until }).eq('id', listId).is('append_lease_token', null).select('id')
    if (free.error) throw free.error
    if ((free.data ?? []).length) return token
    const stale = await lists().update({ append_lease_token: token, append_lease_until: until }).eq('id', listId).lt('append_lease_until', now()).select('id')
    if (stale.error) throw stale.error
    if ((stale.data ?? []).length) return token
    await wait()
  }
  throw new ListBusy()
}

/** Insert a batch; on a unique-key conflict (the backstop indexes) insert row by row and count the clashes as duplicates. */
async function insertBatch(batch: Record<string, unknown>[]): Promise<{ inserted: number; clashes: number }> {
  const { error } = await items().insert(batch)
  if (!error) return { inserted: batch.length, clashes: 0 }
  if ((error as { code?: string }).code !== '23505') throw error
  let inserted = 0
  let clashes = 0
  for (const one of batch) {
    const r = await items().insert(one)
    if (!r.error) inserted++
    else if ((r.error as { code?: string }).code === '23505') clashes++
    else throw r.error
  }
  return { inserted, clashes }
}

async function appendLocked(listId: string, rows: readonly IncomingRow[], max: number): Promise<AppendResult> {
  const first = await recount(listId)
  let count = first.item_count
  const before = (await getList(listId))?.columns ?? []
  let columns = before
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
    columns = mergeColumns(columns, plan.add.map((j) => chunk[j].cells))
    const batch = plan.add.map((j) => {
      const k = keys[j]
      if (k.email_key) added.emails.add(k.email_key)
      if (k.linkedin_key) added.linkedins.add(k.linkedin_key)
      if (k.name_key) added.names.add(k.name_key)
      return { set_id: listId, idx: idx++, item: chunk[j].item as unknown as Json, raw: (chunk[j].raw ?? null) as Json, cells: pickCells(chunk[j].cells, columns) as Json, status: 'kept', source: chunk[j].source, ...k }
    })
    const put = await insertBatch(batch)
    out.added += put.inserted
    out.duplicates += put.clashes
    count += put.inserted
    // idx stays unique even when some rows clashed: the next chunk starts past every idx tried.
  }
  if (columns.length !== before.length) {
    const { error } = await lists().update({ columns }).eq('id', listId)
    if (error) throw error
  }
  out.item_count = (await recount(listId, out.added > 0)).item_count
  return out
}

/** A sort: the row order, or a column whose name is a plain identifier (PostgREST json path). */
export type SortField = string
const SORTABLE = /^[A-Za-z0-9_]{1,80}$/
export const isSortable = (column: string) => SORTABLE.test(column)

/** The generated, trigram-indexed search_text (lume_lead_items_search): name, first / last name, company, email, title, city, domain. */
const asRow = (r: { idx: number; item: ListItem; cells: Cells | null; source: ItemSource | null }): ListRow => ({ ...r, cells: r.cells ?? labelCells(r.item) })

/**
 * One page of rows (a range on the (set_id, idx) index); `q` searches the
 * indexed search_text. Without a search, `knownTotal` (the list's cached
 * item_count) stands in for an exact count on every page.
 */
export async function pageItems(
  listId: string,
  opts: { page?: number; pageSize?: number; q?: string; sort?: SortField; dir?: 'asc' | 'desc'; knownTotal?: number } = {}
): Promise<{ rows: ListRow[]; total: number }> {
  const page = Math.max(0, opts.page ?? 0)
  const size = Math.min(500, Math.max(1, opts.pageSize ?? 50))
  const searching = !!opts.q?.trim()
  const useKnown = !searching && opts.knownTotal !== undefined
  let q = items().select('idx,item,cells,source', useKnown ? undefined : { count: 'exact' }).eq('set_id', listId)
  const term = opts.q?.trim().replace(/[%,()*\\]/g, ' ').trim()
  if (term) q = q.ilike('search_text', `%${term.toLowerCase()}%`)
  const sort = opts.sort && opts.sort !== 'idx' && isSortable(opts.sort) ? `cells->>${opts.sort}` : 'idx'
  q = q.order(sort, { ascending: opts.dir !== 'desc' })
  if (sort !== 'idx') q = q.order('idx', { ascending: true })
  const { data, error, count } = await q.range(page * size, page * size + size - 1)
  if (error) throw error
  return { rows: ((data ?? []) as unknown as Parameters<typeof asRow>[0][]).map(asRow), total: useKnown ? opts.knownTotal! : (count ?? 0) }
}

/** Edit one cell; a helper field that showed the old value follows it, and so do the dedupe keys and the email count. null when the row is not there. */
export async function updateCell(listId: string, idx: number, column: string, value: string): Promise<ListRow | null> {
  const { data, error } = await items().select('idx,item,cells,source').eq('set_id', listId).eq('idx', idx).maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = asRow(data as unknown as Parameters<typeof asRow>[0])
  const next = editCell(row.cells, row.item, column, value)
  const up = await items().update({ item: next.item as unknown as Json, cells: next.cells as Json, ...dedupeKeys(next.item) }).eq('set_id', listId).eq('idx', idx)
  if (up.error) throw up.error
  const list = await getList(listId)
  if (list && !list.columns.includes(column)) await lists().update({ columns: mergeColumns(list.columns, [{ [column]: value }]) }).eq('id', listId)
  await recount(listId, true)
  return { ...row, item: next.item, cells: next.cells }
}

/** Edit helper fields of one row (the agent never does this; kept for the model's field edits). */
export async function updateItem(listId: string, idx: number, patch: Partial<Record<EditableField, string | null>>): Promise<ListRow | null> {
  const { data, error } = await items().select('idx,item,cells,source').eq('set_id', listId).eq('idx', idx).maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = asRow(data as unknown as Parameters<typeof asRow>[0])
  const item = applyItemEdit(row.item, patch)
  const up = await items().update({ item: item as unknown as Json, ...dedupeKeys(item) }).eq('set_id', listId).eq('idx', idx)
  if (up.error) throw up.error
  await recount(listId, true)
  return { ...row, item }
}

export async function deleteItems(listId: string, idxs: readonly number[]): Promise<number> {
  let removed = 0
  for (let i = 0; i < idxs.length; i += CHUNK) {
    const { data, error } = await items().delete().eq('set_id', listId).in('idx', idxs.slice(i, i + CHUNK)).select('idx')
    if (error) throw error
    removed += (data ?? []).length
  }
  if (idxs.length) await recount(listId, removed > 0)
  return removed
}

export const MISSING = ['email', 'linkedin', 'phone', 'website'] as const

/** How many rows a removal by `missing` / `q` would take (head-only counts; rows matching several are counted once per criterion). */
export async function countWhere(listId: string, f: { missing?: (typeof MISSING)[number][]; q?: string }): Promise<number> {
  let n = 0
  for (const m of f.missing ?? []) {
    const col = m === 'email' ? 'email_key' : m === 'linkedin' ? 'linkedin_key' : `item->>${m}`
    const { count, error } = await items().select('id', { count: 'exact', head: true }).eq('set_id', listId).is(col, null)
    if (error) throw error
    n += count ?? 0
  }
  const term = f.q?.trim().replace(/[%,()*\\]/g, ' ').trim()
  if (term) {
    const { count, error } = await items()
      .select('id', { count: 'exact', head: true })
      .eq('set_id', listId)
      .ilike('search_text', `%${term.toLowerCase()}%`)
    if (error) throw error
    n += count ?? 0
  }
  return n
}

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
      .ilike('search_text', `%${term.toLowerCase()}%`)
      .select('idx')
    if (error) throw error
    removed += (data ?? []).length
  }
  await recount(listId, removed > 0)
  return removed
}

/** A list's visible columns (its own, else the readable labels for rows written without a source). */
async function visibleColumns(listId: string): Promise<string[]> {
  const cols = (await getList(listId))?.columns ?? []
  return cols.length ? cols : LIST_COLUMNS.map((c) => c.label)
}

/** The list as CSV in its own columns, `pageSize` rows at a time: the header, then one chunk per page. */
export async function* csvChunks(listId: string, pageSize = 1000): AsyncGenerator<string> {
  const columns = await visibleColumns(listId)
  yield cellsCsvHeader(columns) + '\n'
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await items().select('idx,item,cells,source').eq('set_id', listId).order('idx', { ascending: true }).range(from, from + pageSize - 1)
    if (error) throw error
    const page = ((data ?? []) as unknown as Parameters<typeof asRow>[0][]).map(asRow)
    if (page.length) yield page.map((r) => cellsCsvLine(r.cells, columns)).join('\n') + '\n'
    if (page.length < pageSize) return
  }
}

/** Most bytes the validator CSV may reach (lib/import/csv.ts MAX_CSV_BYTES). */
export const SEND_MAX_BYTES = 20 * 1024 * 1024

export class SendTooLarge extends Error {
  constructor() {
    super('too_large')
    this.name = 'SendTooLarge'
  }
}

/**
 * The rows that carry an email, as the validator CSV: the list's own columns,
 * with exactly one email column the ingest gate detects (the source's, its
 * blanks filled from the helper; or an added Email column). Read page by
 * page; stops with SendTooLarge as soon as it passes `maxBytes`.
 */
export async function emailCsv(listId: string, pageSize = 1000, maxBytes = SEND_MAX_BYTES): Promise<{ csv: string; rows: number; email_column: string }> {
  const { header, emailColumn, added } = sendHeader(await visibleColumns(listId))
  const source = added ? null : emailColumn
  const headerLine = cellsCsvHeader(header)
  const parts: string[] = [headerLine]
  let bytes = headerLine.length + 1
  let rows = 0
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await items().select('idx,item,cells,source').eq('set_id', listId).not('email_key', 'is', null).order('idx', { ascending: true }).range(from, from + pageSize - 1)
    if (error) throw error
    const page = ((data ?? []) as unknown as Parameters<typeof asRow>[0][]).map(asRow)
    for (const r of page) {
      const cells: Cells = {}
      header.forEach((h, i) => {
        if (added && i === header.length - 1) cells[h] = r.item.email ?? ''
        else {
          const orig = added ? (Object.keys(r.cells).find((k) => `${k} (source)` === h) ?? h) : h
          cells[h] = r.cells[orig] ?? ''
        }
      })
      if (source && !cells[source]?.trim()) cells[source] = r.item.email ?? ''
      const line = cellsCsvLine(cells, header)
      bytes += Buffer.byteLength(line) + 1
      if (bytes > maxBytes) throw new SendTooLarge()
      parts.push(line)
    }
    rows += page.length
    if (page.length < pageSize) break
  }
  return { csv: parts.join('\n') + '\n', rows, email_column: emailColumn }
}

/**
 * Claim the send atomically (lume_claim_lead_list_send): only a list never
 * sent, or changed since it was sent, is claimable — two quick clicks, or the
 * page and the agent's approval, make one ingest. Release it if the ingest fails.
 */
export async function claimSend(listId: string): Promise<{ claimed: boolean; prev_sent_at: string | null }> {
  const { data, error } = await db().rpc('lume_claim_lead_list_send', { p_list: listId })
  if (error) throw error
  const row = ((data ?? []) as { prev_sent_at: string | null }[])[0]
  return row ? { claimed: true, prev_sent_at: row.prev_sent_at ?? null } : { claimed: false, prev_sent_at: null }
}

export async function releaseSend(listId: string, prevSentAt: string | null): Promise<void> {
  const { error } = await lists().update({ sent_at: prevSentAt }).eq('id', listId).is('sent_ingest_id', null)
  if (error) throw error
}

/** Record the ingest the claimed send went to (sent_at was stamped by the claim). */
export async function markSent(listId: string, ingestId: string, rows: number): Promise<void> {
  const { error } = await lists().update({ sent_ingest_id: ingestId, sent_rows: rows }).eq('id', listId)
  if (error) throw error
}
