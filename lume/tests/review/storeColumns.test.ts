import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

let db = memdb({ lead_review_items: ['set_id', 'idx'] })
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/apollo/source', () => ({ loadSourceRows: vi.fn() }))

import { createReviewSetFromRows, ensureCells, getReviewSet, loadRows } from '@/lib/review/store'

beforeEach(() => {
  db = memdb({ lead_review_items: ['set_id', 'idx'] })
})

describe('review set columns', () => {
  it("an actor run's set shows the actor's own fields: its key order, nested flattened, later keys appended; the mapped item stays as the helper", async () => {
    const rows = [
      { title: 'Roof Co', website: 'roof.co', location: { city: 'Austin', state: 'TX' }, categories: ['Roofer', 'Contractor'] },
      { title: 'Gutter Inc', phone: '555', email: 'g@gutter.co' },
    ]
    const { set } = await createReviewSetFromRows({ kind: 'run', id: 'abcdefgh12', label: 'run', rows })
    expect(set.columns).toEqual(['title', 'website', 'location.city', 'location.state', 'categories', 'phone', 'email'])
    const loaded = await loadRows(set.id)
    expect(loaded[0].cells).toEqual({ title: 'Roof Co', website: 'roof.co', 'location.city': 'Austin', 'location.state': 'TX', categories: 'Roofer; Contractor' })
    expect(loaded[1].item.email).toBe('g@gutter.co')
    expect(loaded[0].item.domain).toBe('roof.co')
  })

  it('a wide actor (158 keys) keeps every field in the rows and all_columns; shown columns are 100, company fields included', async () => {
    const post = { type: 'post', ...Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`post_f${i}`, 'v'])) }
    const company = { type: 'company', 'company.name': 'Acme', 'company_details.size': '10' }
    const rows = [...Array.from({ length: 20 }, () => post), company]
    const { set } = await createReviewSetFromRows({ kind: 'run', id: 'abcdefgh12', label: 'run', rows })
    expect(set.all_columns).toHaveLength(153)
    expect(set.columns).toHaveLength(100)
    expect(set.columns).toEqual(expect.arrayContaining(['type', 'company.name', 'company_details.size']))
    const loaded = await loadRows(set.id)
    expect(Object.keys(loaded[0].cells!)).toHaveLength(151)
  })

  // The SQL lume_set_lead_cells: sets ONLY cells for [{idx, cells}].
  const setCellsRpc = () => {
    db.rpcs.lume_set_lead_cells = ({ p_set, p_rows }) => {
      for (const r of p_rows as { idx: number; cells: Record<string, string> }[]) {
        const row = db.table('lead_review_items').find((x) => x.set_id === p_set && x.idx === r.idx)
        if (row) row.cells = r.cells
      }
      return (p_rows as unknown[]).length
    }
  }
  const oldSet = (o: Record<string, unknown> = {}) =>
    db.table('lead_review_sets').push({ id: 'old', title: 'old', kind: 'review', source_kind: 'run', source_id: 'x', item_count: 3, columns: [], all_columns: [], filters: [], archived_at: null, cells_backfilled_at: null, ...o })

  it('a set stored before cells existed gets them from raw on first read, page by page, writing only cells', async () => {
    setCellsRpc()
    oldSet()
    db.table('lead_review_items').push(
      { id: 901, set_id: 'old', idx: 0, item: {}, raw: { author: { name: 'Ann' }, type: 'post' }, status: 'kept', excluded_reason: null, filter_id: null },
      { id: 902, set_id: 'old', idx: 1, item: {}, raw: { author: { name: 'Bo' }, type: 'post' }, status: 'kept', excluded_reason: null, filter_id: null },
      { id: 903, set_id: 'old', idx: 2, item: {}, raw: { company: { name: 'Acme' }, type: 'company' }, status: 'kept', excluded_reason: null, filter_id: null }
    )
    const set0 = (await getReviewSet('old'))!
    // A filter lands while the backfill runs: it must survive.
    db.table('lead_review_items').find((r) => r.id === 902)!.status = 'excluded'
    const set = await ensureCells(set0, { pageSize: 2 })
    expect(set.all_columns).toEqual(['author.name', 'type', 'company.name'])
    expect(set.columns).toEqual(['author.name', 'type', 'company.name'])
    expect(db.table('lead_review_items').find((r) => r.id === 901)!.cells).toEqual({ 'author.name': 'Ann', type: 'post' })
    expect(db.table('lead_review_items').find((r) => r.id === 903)!.cells).toEqual({ 'company.name': 'Acme', type: 'company' })
    expect(db.table('lead_review_items').find((r) => r.id === 902)!.status).toBe('excluded')
    const stored = (await getReviewSet('old'))!
    expect(stored.all_columns).toEqual(['author.name', 'type', 'company.name'])
    expect(db.table('lead_review_sets')[0].cells_backfilled_at).toBeTruthy()
  })

  it('a set whose rows have no raw is marked attempted and not re-scanned on the next read', async () => {
    setCellsRpc()
    oldSet({ item_count: 1 })
    db.table('lead_review_items').push({ id: 904, set_id: 'old', idx: 0, item: {}, raw: null, status: 'kept', excluded_reason: null, filter_id: null })
    await ensureCells((await getReviewSet('old'))!)
    expect(db.table('lead_review_sets')[0].cells_backfilled_at).toBeTruthy()
    const realFrom = db.client.from
    let itemReads = 0
    db.client.from = ((t: string) => {
      if (t === 'lead_review_items') itemReads++
      return realFrom(t)
    }) as typeof db.client.from
    await ensureCells((await getReviewSet('old'))!)
    db.client.from = realFrom
    expect(itemReads).toBe(0)
  })
})
