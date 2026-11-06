import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

let db = memdb({ lead_review_items: ['set_id', 'idx'] })
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))

import {
  appendItems,
  createList,
  csvChunks,
  deleteItems,
  getList,
  listLists,
  moveList,
  pageItems,
  projectDefaultList,
  removeWhere,
  updateCell,
  emailCsv,
  claimSend,
} from '@/lib/leads/lists/store'
import { normaliseLead } from '@/lib/review/model'
import type { ListItem } from '@/lib/leads/lists/model'

const lead = (o: Partial<ListItem>): ListItem => ({ ...normaliseLead({}), ...o })
// The row as an actor would have it: its own keys are the cells.
const row = (o: Partial<ListItem>, source: 'agent' | 'manual' = 'agent') => ({
  raw: { ...o } as Record<string, unknown>,
  item: lead(o),
  source,
  cells: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v ?? '')])),
})

beforeEach(() => {
  db = memdb({ lead_review_items: ['set_id', 'idx'] })
})

describe('lead list store', () => {
  it('creates a named list and appends with dedupe against what is already there; counts and next idx follow', async () => {
    const list = await createList({ name: 'PM owners', notes: 'from chat', created_by: 'agent' })
    expect(list).toMatchObject({ name: 'PM owners', notes: 'from chat', created_by: 'agent', item_count: 0, email_count: 0, project_id: null })
    const a = await appendItems(list.id, [row({ email: 'a@x.com', name: 'A' }), row({ linkedin_url: 'https://linkedin.com/in/bee', name: 'B' }), row({ title: 'nobody' })])
    expect(a).toMatchObject({ added: 2, duplicates: 0, skipped: 1, over_cap: 0, item_count: 2 })
    const b = await appendItems(list.id, [row({ email: 'A@X.com' }), row({ linkedin_url: 'linkedin.com/in/bee/' }), row({ email: 'c@x.com', name: 'C' }, 'manual')])
    expect(b).toMatchObject({ added: 1, duplicates: 2, item_count: 3 })
    const items = db.table('lead_review_items').filter((r) => r.set_id === list.id)
    expect(items.map((r) => [r.idx, r.email_key, r.linkedin_key, r.source])).toEqual([
      [0, 'a@x.com', null, 'agent'],
      [1, null, 'in/bee', 'agent'],
      [2, 'c@x.com', null, 'manual'],
    ])
    expect(await getList(list.id)).toMatchObject({ item_count: 3, email_count: 2 })
  })

  it('stops at the cap', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    await appendItems(list.id, [row({ email: 'a@a.co' })], { max: 2 })
    const r = await appendItems(list.id, [row({ email: 'b@a.co' }), row({ email: 'c@a.co' }), row({ email: 'd@a.co' })], { max: 2 })
    expect(r).toMatchObject({ added: 1, over_cap: 2, item_count: 2 })
  })

  it('pages, searches and sorts', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    await appendItems(list.id, [row({ name: 'Zeta', email: 'z@z.co' }), row({ name: 'Alpha', email: 'a@a.co' }), row({ name: 'Mid', email: 'm@acme.co' })])
    const sorted = await pageItems(list.id, { page: 0, pageSize: 2, sort: 'name', dir: 'asc' })
    expect(sorted.total).toBe(3)
    expect(sorted.rows.map((r) => r.item.name)).toEqual(['Alpha', 'Mid'])
    const found = await pageItems(list.id, { q: 'acme' })
    expect(found.rows.map((r) => r.idx)).toEqual([2])
  })

  it('edits a cell (keys and email count follow), deletes rows, removes rows missing an email', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    await appendItems(list.id, [row({ name: 'A', company: 'A Co', email: 'a@a.co' }), row({ name: 'B', company: 'B Co' }), row({ name: 'C', company: 'C Co', email: 'c@c.co' })])
    const edited = await updateCell(list.id, 1, 'email', 'b@b.co')
    expect(edited?.cells.email).toBe('b@b.co')
    expect(db.table('lead_review_items').find((r) => r.idx === 1)!.email_key).toBe('b@b.co')
    expect((await getList(list.id))!.email_count).toBe(3)
    await updateCell(list.id, 0, 'email', '')
    expect(await removeWhere(list.id, { missing: ['email'] })).toBe(1)
    expect(await deleteItems(list.id, [2])).toBe(1)
    expect(await getList(list.id)).toMatchObject({ item_count: 1, email_count: 1 })
    expect(await updateCell(list.id, 99, 'email', 'x@y.co')).toBeNull()
  })

  it("a project's default list is created once, named after the project; moving a list out clears the default", async () => {
    const one = await projectDefaultList('p-1', 'Roofers TX')
    const again = await projectDefaultList('p-1', 'Roofers TX')
    expect(again.id).toBe(one.id)
    expect(one).toMatchObject({ name: 'Roofers TX', project_id: 'p-1', project_default: true, created_by: 'agent' })
    await moveList(one.id, null)
    expect(await getList(one.id)).toMatchObject({ project_id: null, project_default: false })
    expect((await listLists()).map((l) => l.id)).toEqual([one.id])
  })

  it('CSV streams in pages: header first, one line per row', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    await appendItems(list.id, [row({ name: 'A', email: 'a@a.co' }), row({ name: 'B', email: 'b@b.co' }), row({ name: 'C', email: 'c@c.co' })])
    const chunks: string[] = []
    for await (const c of csvChunks(list.id, 2)) chunks.push(c)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toBe('name,email\n')
    expect(chunks.join('').trim().split('\n')).toHaveLength(4)
  })

  it("shows the sources' own columns: first-seen order, union across sources, blanks where a row lacks one", async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    await appendItems(list.id, [row({ name: 'A', email: 'a@a.co', city: 'Austin' })])
    await appendItems(list.id, [{ ...row({ email: 'b@b.co' }), cells: { email: 'b@b.co', 'author.name': 'Bo' } }])
    expect((await getList(list.id))!.columns).toEqual(['name', 'email', 'city', 'author.name'])
    const page = await pageItems(list.id, {})
    expect(page.rows.map((r) => r.cells)).toEqual([{ name: 'A', email: 'a@a.co', city: 'Austin' }, { email: 'b@b.co', 'author.name': 'Bo' }])
    const chunks: string[] = []
    for await (const c of csvChunks(list.id)) chunks.push(c)
    expect(chunks.join('')).toBe('name,email,city,author.name\nA,a@a.co,Austin,\n,b@b.co,,Bo\n')
  })

  it('the validator CSV keeps the source columns with one email column; without one it adds Email from the helper; it stops past the size cap', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    await appendItems(list.id, [{ ...row({ name: 'A', email: 'a@a.co' }), cells: { name: 'A', contact: 'x' } }, row({ name: 'NoMail', company: 'N Co' })])
    const out = await emailCsv(list.id)
    expect(out.email_column).toBe('Email')
    expect(out.csv).toBe('name,contact,company,Email\nA,x,,a@a.co\n')
    await expect(emailCsv(list.id, 1000, 10)).rejects.toThrow('too_large')
  })
})

describe('lead list store: review fixes', () => {
  const changedAt = (id: string) => db.table('lead_review_sets').find((r) => r.id === id)!.content_changed_at as string

  it('content_changed_at moves only when rows are added, edited or removed — not on an all-duplicate append or a remove of nothing', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    await appendItems(list.id, [row({ email: 'a@a.co', name: 'A' })])
    const t1 = changedAt(list.id)
    await new Promise((r) => setTimeout(r, 5))
    await appendItems(list.id, [row({ email: 'A@a.co' })])
    expect(await removeWhere(list.id, { missing: ['linkedin'] })).toBe(1) // removes the one row without LinkedIn...
    expect(changedAt(list.id) > t1).toBe(true)
    const t2 = changedAt(list.id)
    await new Promise((r) => setTimeout(r, 5))
    expect(await removeWhere(list.id, { missing: ['linkedin'] })).toBe(0)
    expect(await deleteItems(list.id, [42])).toBe(0)
    await appendItems(list.id, [])
    expect(changedAt(list.id)).toBe(t2)
  })

  it('two appends at once are serialised: no idx collision, no duplicate slips past the check', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    const a = Array.from({ length: 30 }, (_, i) => row({ email: `p${i}@x.co` }))
    const b = Array.from({ length: 30 }, (_, i) => row({ email: `p${i + 15}@x.co` }))
    const [ra, rb] = await Promise.all([appendItems(list.id, a, { wait: () => new Promise((r) => setTimeout(r, 1)) }), appendItems(list.id, b, { wait: () => new Promise((r) => setTimeout(r, 1)) })])
    expect(ra.added + rb.added).toBe(45)
    expect(ra.duplicates + rb.duplicates).toBe(15)
    const its = db.table('lead_review_items').filter((r) => r.set_id === list.id)
    expect(new Set(its.map((r) => r.idx)).size).toBe(45)
    expect(new Set(its.map((r) => r.email_key)).size).toBe(45)
    expect(db.table('lead_review_sets').find((r) => r.id === list.id)!.append_lease_token).toBeNull()
  })

  it('a stale lease (a crashed append) is taken over; a live one makes the caller wait, then give up as busy', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    const set = db.table('lead_review_sets').find((r) => r.id === list.id)!
    Object.assign(set, { append_lease_token: 'old', append_lease_until: new Date(Date.now() - 1000).toISOString() })
    expect((await appendItems(list.id, [row({ email: 'a@a.co' })])).added).toBe(1)
    Object.assign(set, { append_lease_token: 'other', append_lease_until: new Date(Date.now() + 60_000).toISOString() })
    await expect(appendItems(list.id, [row({ email: 'b@a.co' })], { wait: () => Promise.resolve(), attempts: 3 })).rejects.toThrow('list_busy')
  })

  it('claimSend goes through the atomic claim RPC; no row back = already sent unchanged', async () => {
    const list = await createList({ name: 'L', created_by: 'owner' })
    let claims = 0
    db.rpcs.lume_claim_lead_list_send = () => (claims++ === 0 ? [{ prev_sent_at: null, content_changed_at: 'x' }] : [])
    expect(await claimSend(list.id)).toEqual({ claimed: true, prev_sent_at: null })
    expect(await claimSend(list.id)).toEqual({ claimed: false, prev_sent_at: null })
  })
})
