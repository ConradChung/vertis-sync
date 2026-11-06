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
  updateItem,
} from '@/lib/leads/lists/store'
import { normaliseLead } from '@/lib/review/model'
import type { ListItem } from '@/lib/leads/lists/model'

const lead = (o: Partial<ListItem>): ListItem => ({ ...normaliseLead({}), ...o })
const row = (o: Partial<ListItem>, source: 'agent' | 'manual' = 'agent') => ({ raw: { ...o } as Record<string, unknown>, item: lead(o), source })

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
    const edited = await updateItem(list.id, 1, { email: 'b@b.co' })
    expect(edited?.item.email).toBe('b@b.co')
    expect(db.table('lead_review_items').find((r) => r.idx === 1)!.email_key).toBe('b@b.co')
    expect((await getList(list.id))!.email_count).toBe(3)
    await updateItem(list.id, 0, { email: '' })
    expect(await removeWhere(list.id, { missing: ['email'] })).toBe(1)
    expect(await deleteItems(list.id, [2])).toBe(1)
    expect(await getList(list.id)).toMatchObject({ item_count: 1, email_count: 1 })
    expect(await updateItem(list.id, 99, { email: 'x@y.co' })).toBeNull()
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
    expect(chunks[0].startsWith('Name,First Name')).toBe(true)
    expect(chunks.join('').trim().split('\n')).toHaveLength(4)
  })
})
