import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

// The column default the migration gives pipeline_step (memdb has no defaults).
const DEFAULTS = { lead_review_items: (r: Record<string, unknown>) => ({ pipeline_step: r.pipeline_step ?? 1 }) }
let db = memdb({ lead_review_items: ['set_id', 'idx'] }, DEFAULTS)
const h = vi.hoisted(() => ({ getProject: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: async () => ({ ok: true, via: 'session', user: null }) }))
vi.mock('@/lib/agent/projects', () => ({ getProject: h.getProject, listProjects: vi.fn().mockResolvedValue([]) }))

import * as combineRoute from '@/app/api/lead-lists/combine/route'
import * as finalRoute from '@/app/api/lead-lists/[id]/final/route'
import { appendItems, createList, csvChunks, emailCsv, getList, pageItems } from '@/lib/leads/lists/store'
import { savedText } from '@/components/leads/StageDialogs'
import { normaliseLead } from '@/lib/review/model'
import { stepLabel } from '@/lib/leads/steps'
import type { ListItem } from '@/lib/leads/lists/model'

const lead = (o: Partial<ListItem>): ListItem => ({ ...normaliseLead({}), ...o })
// A Maps business: its name is its company too (that is what lets a row with no website or email into a list).
const row = (p: Partial<ListItem>) => {
  const o = { company: p.name, ...p }
  return { raw: { ...o } as Record<string, unknown>, item: lead(o), source: 'manual' as const, cells: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v ?? '')])) }
}
const req = (body: unknown) => new Request('http://x/api/lead-lists/combine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

let n = 0
async function list(name: string, rows: Partial<ListItem>[]) {
  const l = await createList({ name, created_by: 'owner' })
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  db.table('lead_review_sets').find((r) => r.id === l.id)!.id = id
  await appendItems(id, rows.map(row))
  return id
}
const itemsOf = (id: string) => db.table('lead_review_items').filter((r) => r.set_id === id).sort((a, b) => (a.idx as number) - (b.idx as number))

beforeEach(() => {
  db = memdb({ lead_review_items: ['set_id', 'idx'] }, DEFAULTS)
  h.getProject.mockReset().mockResolvedValue(null)
})

describe('combine route (step 2)', () => {
  it('previews without writing, then saves a combined master with every row at 2 · Combined', async () => {
    const maps = await list('Maps LA', [
      { name: 'Sunset PM', domain: 'sunsetpm.com', phone: '+1 310 555 0100' },
      { name: 'Harbor Homes', domain: 'harborhomes.com' },
    ])
    const apollo = await list('Apollo LA', [{ name: 'Ann Lee', email: 'ann@sunsetpm.com', phone: '+1 999' }])
    const before = db.table('lead_review_sets').length

    const preview = await combineRoute.POST(req({ list_ids: [maps, apollo], preview: true }))
    expect(preview.status).toBe(200)
    expect((await preview.json()).stats).toMatchObject({ input_rows: 3, output_rows: 2, merged: 1, rows_with_conflicts: 1 })
    expect(db.table('lead_review_sets')).toHaveLength(before)

    const res = await combineRoute.POST(req({ list_ids: [maps, apollo], name: 'LA master' }))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.list).toMatchObject({ name: 'LA master', sheet_stage: 'combined', source_list_ids: [maps, apollo] })
    expect(j.href).toContain(j.list.id)
    const rows = itemsOf(j.list.id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.pipeline_step === 2)).toBe(true)
    // Maps came first, so its phone stays; the audit says where the row came from.
    expect((rows[0].cells as Record<string, string>).phone).toBe('+1 310 555 0100')
    expect((rows[0].raw as { combined_from: { list: string }[] }).combined_from.map((s) => s.list)).toEqual(['Maps LA', 'Apollo LA'])
    // The source lists are untouched.
    expect(itemsOf(maps).every((r) => r.pipeline_step === 1)).toBe(true)
  })

  it('prefer needs a preferred list from the chosen ones; a missing list is a 404', async () => {
    const a = await list('A', [{ name: 'X', domain: 'x.com' }])
    const b = await list('B', [{ name: 'Y', domain: 'x.com' }])
    expect((await combineRoute.POST(req({ list_ids: [a, b], rule: 'prefer', preview: true }))).status).toBe(400)
    const other = '00000000-0000-4000-8000-999999999999'
    expect(await (await combineRoute.POST(req({ list_ids: [a, b], rule: 'prefer', prefer_list_id: other, preview: true }))).json()).toEqual({ error: 'prefer_not_in_lists' })
    const missing = await combineRoute.POST(req({ list_ids: [a, other], preview: true }))
    expect(missing.status).toBe(404)
    expect((await combineRoute.POST(req({ list_ids: [a, b] }))).status).toBe(400) // a save needs a name
  })
})

describe('final route (step 3)', () => {
  const filter = {
    rules: [
      { criteria: { missing: ['phone'] }, reason: 'no phone' },
      { criteria: { categories_in: ['Hardware store'] }, reason: 'vendor' },
    ],
  }

  it('saves the final sheet: kept rows first, dropouts marked excluded with their reason; the source rows move to step 3', async () => {
    const src = await list('LA master', [
      { name: 'Ace Supply', category: 'Hardware store', phone: '1' },
      { name: 'Sunset PM', category: 'Property management company', phone: '2' },
      { name: 'Quiet PM', category: 'Property management company' },
    ])
    const preview = await finalRoute.POST(req({ filter, preview: true }), ctx(src))
    expect(await preview.json()).toEqual({ kept: 1, excluded: 2, reasons: [{ reason: 'no phone', count: 1 }, { reason: 'vendor', count: 1 }] })

    const res = await finalRoute.POST(req({ filter, name: 'LA final' }), ctx(src))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j).toMatchObject({ kept: 1, excluded: 2, list: { name: 'LA final', sheet_stage: 'final', source_list_ids: [src] } })
    const rows = itemsOf(j.list.id)
    expect(rows.map((r) => [(r.item as ListItem).name, r.status, stepLabel(r.pipeline_step, r.step_note as string | null)])).toEqual([
      ['Sunset PM', 'kept', '3 · Filtered'],
      ['Ace Supply', 'excluded', '3 · Filtered — excluded: vendor'],
      ['Quiet PM', 'excluded', '3 · Filtered — excluded: no phone'],
    ])
    expect(rows[1].excluded_reason).toBe('vendor')
    // The master shows how far each of its rows got; why a row dropped lives on the final sheet only.
    expect(itemsOf(src).map((r) => stepLabel(r.pipeline_step, r.step_note as string | null))).toEqual(['3 · Filtered', '3 · Filtered', '3 · Filtered'])
    // And a page read carries the status to the Leads table.
    const page = await pageItems(j.list.id, { page: 0, pageSize: 10 })
    expect(page.rows.map((r) => [r.pipeline_step, r.status])).toEqual([[3, 'kept'], [3, 'excluded'], [3, 'excluded']])
    expect((await getList(src))?.sheet_stage).toBe('imported')
  })

  it('the dropouts are never counted as sendable, exported or sent', async () => {
    const src = await list('LA master', [
      { name: 'Ace Supply', category: 'Hardware store', phone: '1', email: 'sales@ace.com' },
      { name: 'Sunset PM', category: 'Property management company', phone: '2', email: 'hi@sunsetpm.com' },
      { name: 'Quiet PM', category: 'Property management company', email: 'hi@quiet.com' },
    ])
    const j = await (await finalRoute.POST(req({ filter, name: 'LA final' }), ctx(src))).json()
    const final = (await getList(j.list.id))!
    // The table still shows all three rows; only one counts as sendable.
    expect(final).toMatchObject({ item_count: 3, email_count: 1 })
    let csv = ''
    for await (const c of csvChunks(final.id)) csv += c
    expect(csv).toContain('Sunset PM')
    expect(csv).not.toContain('Ace Supply')
    expect(csv).not.toContain('Quiet PM')
    const send = await emailCsv(final.id)
    expect(send.rows).toBe(1)
    expect(send.csv).toContain('hi@sunsetpm.com')
    expect(send.csv).not.toContain('sales@ace.com')
  })

  it('a second filter run over the same master leaves its rows at step 3 with no stale reason', async () => {
    const src = await list('LA master', [
      { name: 'Ace Supply', category: 'Hardware store', phone: '1' },
      { name: 'Sunset PM', category: 'Property management company', phone: '2' },
    ])
    await finalRoute.POST(req({ filter, name: 'F1' }), ctx(src))
    const j2 = await (await finalRoute.POST(req({ filter: { rules: [{ criteria: { categories_in: ['Property management company'] }, reason: 'not this time' }] }, name: 'F2' }), ctx(src))).json()
    expect(itemsOf(src).map((r) => [r.pipeline_step, r.step_note ?? null])).toEqual([[3, null], [3, null]])
    expect(itemsOf(j2.list.id).map((r) => [(r.item as ListItem).name, r.step_note])).toEqual([
      ['Ace Supply', null],
      ['Sunset PM', 'excluded: not this time'],
    ])
  })

  it('the save toast says how many rows went in and what was left out', () => {
    expect(savedText('LA final', 'final sheet', { added: 1204, duplicates: 3, skipped: 0, over_cap: 0 })).toBe('Saved "LA final" as the final sheet: 1,204 rows (left out: 3 duplicates).')
    expect(savedText('M', 'combined master', { added: 1, duplicates: 0, skipped: 0, over_cap: 0 })).toBe('Saved "M" as the combined master: 1 row.')
    expect(savedText('M', 'combined master')).toBe('Saved "M" as the combined master.')
  })

  it('never moves a row back, and refuses a filter that keeps nothing', async () => {
    const src = await list('M', [{ name: 'A', category: 'Hardware store', phone: '1' }])
    db.table('lead_review_items').find((r) => r.set_id === src)!.pipeline_step = 4
    const res = await finalRoute.POST(req({ filter, name: 'F' }), ctx(src))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'nothing_kept' })

    const ok = await list('N', [{ name: 'B', category: 'Roofer', phone: '1' }, { name: 'C', category: 'Roofer', phone: '2' }])
    db.table('lead_review_items').find((r) => r.set_id === ok && r.idx === 0)!.pipeline_step = 4
    await finalRoute.POST(req({ filter, name: 'F2' }), ctx(ok))
    expect(itemsOf(ok).map((r) => r.pipeline_step)).toEqual([4, 3])
  })
})
