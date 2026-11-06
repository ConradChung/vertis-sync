import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { memdb } from '../stubs/memdb'

let db = memdb({ lead_review_items: ['set_id', 'idx'] })
const h = vi.hoisted(() => ({ via: 'session' as 'session' | 'internal', getProject: vi.fn(), listProjects: vi.fn(), createIngest: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/auth/guards', () => ({
  requireOwner: async () => ({ ok: true, via: h.via, user: null }),
  requireOwnerSession: async () => (h.via === 'session' ? { ok: true, via: 'session', user: {} } : { ok: false, response: NextResponse.json({ error: 'session_required' }, { status: 403 }) }),
}))
vi.mock('@/lib/agent/projects', () => ({ getProject: h.getProject, listProjects: h.listProjects }))
vi.mock('@/lib/import/ingest', () => ({ createIngest: h.createIngest }))

import * as lists from '@/app/api/lead-lists/route'
import * as one from '@/app/api/lead-lists/[id]/route'
import * as items from '@/app/api/lead-lists/[id]/items/route'
import * as cell from '@/app/api/lead-lists/[id]/items/[idx]/route'
import * as exp from '@/app/api/lead-lists/[id]/export/route'
import * as send from '@/app/api/lead-lists/[id]/send/route'
import * as auto from '@/app/api/lead-lists/auto/route'

const PROJECT = '33333333-3333-4333-8333-333333333333'
const INGEST = '44444444-4444-4444-8444-444444444444'
const req = (method: string, body?: unknown, url = 'http://x/api/lead-lists') =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = (id: string, idx?: number) => ({ params: Promise.resolve({ id, idx: idx === undefined ? '' : String(idx) }) })

// memdb hands out numeric ids; the routes want uuids. Give each new set a uuid.
let n = 0
const uuidFor = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
async function newList(name = 'PM owners', body: Record<string, unknown> = {}) {
  const res = await lists.POST(req('POST', { name, ...body }))
  const j = await res.json()
  const row = db.table('lead_review_sets').find((r) => r.id === j.list?.id)
  if (row) row.id = uuidFor()
  return { res, id: row?.id as string, json: j }
}

beforeEach(() => {
  db = memdb({ lead_review_items: ['set_id', 'idx'] })
  // The claim RPC, as the SQL does it: stamp sent_at only when never sent or changed since.
  db.rpcs.lume_claim_lead_list_send = ({ p_list }) => {
    const set = db.table('lead_review_sets').find((r) => r.id === p_list && r.kind === 'list')
    if (!set) return []
    const prev = (set.sent_at as string | null) ?? null
    if (prev && !(prev < (set.content_changed_at as string))) return []
    Object.assign(set, { sent_at: new Date().toISOString(), sent_ingest_id: null, sent_rows: null })
    return [{ prev_sent_at: prev, content_changed_at: set.content_changed_at }]
  }
  h.via = 'session'
  h.getProject.mockReset().mockImplementation(async (id: string) => (id === PROJECT ? { id: PROJECT, name: 'Roofers TX' } : null))
  h.listProjects.mockReset().mockResolvedValue([{ id: PROJECT, name: 'Roofers TX' }])
  h.createIngest.mockReset().mockResolvedValue({ ingest: { id: INGEST }, rowCount: 1, detectedColumn: 'Email', telegram: 'sent' })
})

describe('lead list routes', () => {
  it('creates (owner vs agent tagged), appends inline with dedupe and reports the line, lists in the folder tree', async () => {
    const { res, id, json } = await newList('PM owners', { project_id: PROJECT })
    expect(res.status).toBe(201)
    expect(json.list.created_by).toBe('owner')
    const add = await items.POST(req('POST', { source: { kind: 'inline', rows: [{ name: 'A', email: 'a@a.co' }, { name: 'B', email: 'A@a.co' }] } }), ctx(id))
    const r = await add.json()
    expect(r).toMatchObject({ added: 1, duplicates: 1, name: 'PM owners', href: `/import/leads?list=${id}`, line: 'added 1, 1 duplicate skipped → PM owners' })
    expect(db.table('lead_review_items')[0].source).toBe('manual')
    const tree = await (await lists.GET(req('GET'))).json()
    expect(tree.folders.map((f: { name: string; lists: unknown[] }) => [f.name, f.lists.length])).toEqual([['Roofers TX', 1], ['Unfiled', 0]])
    h.via = 'internal'
    expect((await newList('Agent list')).json.list.created_by).toBe('agent')
  })

  it('the agent caps inline rows at 200 per call', async () => {
    const { id } = await newList()
    h.via = 'internal'
    const res = await items.POST(req('POST', { source: { kind: 'inline', rows: Array.from({ length: 201 }, (_, i) => ({ email: `a${i}@a.co` })) } }), ctx(id))
    expect(res.status).toBe(400)
  })

  it('pages with search; cell edit, delete list and send are the owner session only', async () => {
    const { id } = await newList()
    await items.POST(req('POST', { source: { kind: 'paste', text: 'Name\tCompany\tEmail\nAlpha\tA Co\ta@a.co\nBeta\tB Co\t\n' } }), ctx(id))
    const page = await (await items.GET(req('GET', undefined, `http://x/api/lead-lists/${id}/items?q=alp`), ctx(id))).json()
    expect(page.rows.map((r: { item: { first_name: string } }) => r.item.first_name)).toEqual(['Alpha'])
    h.via = 'internal'
    expect((await cell.PATCH(req('PATCH', { column: 'Email', value: 'b@b.co' }), ctx(id, 1))).status).toBe(403)
    expect((await one.DELETE(req('DELETE'), ctx(id))).status).toBe(403)
    expect((await send.POST(req('POST'), ctx(id))).status).toBe(403)
    h.via = 'session'
    const edited = await cell.PATCH(req('PATCH', { column: 'Email', value: 'b@b.co' }), ctx(id, 1))
    const body = await edited.json()
    expect([body.row.cells.Email, body.row.item.email]).toEqual(['b@b.co', 'b@b.co'])
  })

  it('send: refuses a list with no emails; otherwise one CSV ingest and the list records it', async () => {
    const { id } = await newList()
    await items.POST(req('POST', { source: { kind: 'inline', rows: [{ name: 'No Mail', company: 'X Co' }] } }), ctx(id))
    const refused = await send.POST(req('POST'), ctx(id))
    expect(refused.status).toBe(422)
    expect((await refused.json()).error).toBe('no_emails: 0 of 1 rows have an email')
    await items.POST(req('POST', { source: { kind: 'inline', rows: [{ name: 'Mail', email: 'm@m.co' }] } }), ctx(id))
    const ok = await send.POST(req('POST'), ctx(id))
    expect(ok.status).toBe(201)
    expect(await ok.json()).toMatchObject({ ingest_id: INGEST, rows: 1 })
    const csv = new TextDecoder().decode(h.createIngest.mock.calls[0][0])
    expect(csv.trim().split('\n')).toHaveLength(2) // header + the one row with an email
    expect(db.table('lead_review_sets').find((r) => r.id === id)).toMatchObject({ sent_ingest_id: INGEST, sent_rows: 1 })
    expect((await send.POST(req('POST'), ctx(id))).status).toBe(409)
    // An all-duplicate append changes nothing, so the list still cannot be resent.
    await items.POST(req('POST', { source: { kind: 'inline', rows: [{ name: 'Mail', email: 'm@m.co' }] } }), ctx(id))
    expect((await send.POST(req('POST'), ctx(id))).status).toBe(409)
    expect(h.createIngest).toHaveBeenCalledTimes(1)
  })

  it('two quick clicks on Send make one ingest', async () => {
    const { id } = await newList()
    await items.POST(req('POST', { source: { kind: 'inline', rows: [{ name: 'Mail', email: 'm@m.co' }] } }), ctx(id))
    const [a, b] = await Promise.all([send.POST(req('POST'), ctx(id)), send.POST(req('POST'), ctx(id))])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(h.createIngest).toHaveBeenCalledTimes(1)
  })

  it('export streams the CSV; remove by missing email', async () => {
    const { id } = await newList()
    await items.POST(req('POST', { source: { kind: 'inline', rows: [{ name: '=cmd', email: 'a@a.co' }, { name: 'B', company: 'B Co' }] } }), ctx(id))
    const text = await (await exp.GET(req('GET'), ctx(id))).text()
    expect(text.split('\n')[1].startsWith("'=cmd")).toBe(true)
    const removed = await items.DELETE(req('DELETE', { missing: ['email'] }), ctx(id))
    expect(await removed.json()).toEqual({ removed: 1 })
  })

  it("auto-append: a project's default list is created once and named after it; a gone project appends nothing", async () => {
    h.via = 'internal'
    const first = await (await auto.POST(req('POST', { project_id: PROJECT, source: { kind: 'inline', rows: [{ email: 'a@a.co', name: 'A' }] } }))).json()
    expect(first.appended).toMatchObject({ name: 'Roofers TX', added: 1 })
    const second = await (await auto.POST(req('POST', { project_id: PROJECT, source: { kind: 'inline', rows: [{ email: 'a@a.co' }, { email: 'b@b.co' }] } }))).json()
    expect(second.appended).toMatchObject({ list_id: first.appended.list_id, added: 1, duplicates: 1 })
    const gone = await (await auto.POST(req('POST', { project_id: '55555555-5555-4555-8555-555555555555', source: { kind: 'inline', rows: [{ email: 'c@c.co' }] } }))).json()
    expect(gone.appended).toBeNull()
  })
})
