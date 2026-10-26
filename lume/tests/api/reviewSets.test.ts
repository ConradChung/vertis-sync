import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normaliseLead, type ReviewRow } from '@/lib/review/model'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  createReviewSet: vi.fn(),
  getReviewSet: vi.fn(),
  listReviewSets: vi.fn(),
  loadRows: vi.fn(),
  applyFilter: vi.fn(),
  restore: vi.fn(),
  setRowsByHand: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/review/store', () => ({
  createReviewSet: h.createReviewSet,
  getReviewSet: h.getReviewSet,
  listReviewSets: h.listReviewSets,
  loadRows: h.loadRows,
  applyFilter: h.applyFilter,
  restore: h.restore,
  setRowsByHand: h.setRowsByHand,
}))
vi.mock('@/lib/apollo/source', () => {
  class SourceError extends Error {
    constructor(
      readonly status: number,
      readonly code: string
    ) {
      super(code)
    }
  }
  return { SourceError, DATASET_ID_RE: /^[A-Za-z0-9]{8,40}$/, JOB_ID_RE: /^[0-9a-f-]{36}$/i }
})
vi.mock('@/lib/db/service', () => ({ isDbError: () => false }))

import { GET as listGET, POST as createPOST } from '@/app/api/review-sets/route'
import { GET as itemsGET } from '@/app/api/review-sets/[id]/items/route'
import { POST as filterPOST } from '@/app/api/review-sets/[id]/filter/route'
import { POST as restorePOST } from '@/app/api/review-sets/[id]/restore/route'
import { GET as exportGET } from '@/app/api/review-sets/[id]/export/route'

const ID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const ctx = { params: Promise.resolve({ id: ID }) }
const set = { id: ID, title: 'Roofers Austin', source_kind: 'run', source_id: 'abcDEF12345', filters: [], item_count: 2 }
const req = (url: string, method = 'GET', body?: unknown) => new Request(`http://localhost${url}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
const rows: ReviewRow[] = [
  { idx: 0, item: normaliseLead({ title: 'Acme Roofing', website: 'acme.com', categoryName: 'Roofing contractor' }), status: 'kept', excluded_reason: null, filter_id: null },
  { idx: 1, item: normaliseLead({ title: 'Junk LLC', categoryName: 'Bank' }), status: 'excluded', excluded_reason: 'wrong category', filter_id: 'f1' },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwner.mockResolvedValue({ ok: true, via: 'bearer' })
  h.getReviewSet.mockResolvedValue(set)
  h.loadRows.mockResolvedValue(rows)
})

describe('/api/review-sets', () => {
  it('POST loads actor results into a set (load_actor_results)', async () => {
    h.createReviewSet.mockResolvedValue({ set, truncated: false, source_rows: 2 })
    const res = await createPOST(req('/api/review-sets', 'POST', { source: { kind: 'run', id: 'abcDEF12345' }, conversation_id: ID }))
    expect(res.status).toBe(201)
    expect(h.createReviewSet).toHaveBeenCalledWith({ kind: 'run', id: 'abcDEF12345' }, { conversationId: ID, title: undefined })
    const body = await res.json()
    expect(body.summary).toMatchObject({ total: 2, kept: 1, excluded: 1 })
  })

  it('POST rejects a bad source id', async () => {
    const res = await createPOST(req('/api/review-sets', 'POST', { source: { kind: 'run', id: 'x' } }))
    expect(res.status).toBe(400)
    expect(h.createReviewSet).not.toHaveBeenCalled()
  })

  it('GET lists sets for a conversation', async () => {
    h.listReviewSets.mockResolvedValue([set])
    await listGET(req(`/api/review-sets?conversation=${ID}`))
    expect(h.listReviewSets).toHaveBeenCalledWith(ID)
  })

  it('is owner-only', async () => {
    const { NextResponse } = await import('next/server')
    h.requireOwner.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) })
    expect((await itemsGET(req(`/api/review-sets/${ID}/items`), ctx)).status).toBe(401)
  })
})

describe('/api/review-sets/[id]', () => {
  it('items pages by status', async () => {
    const body = await (await itemsGET(req(`/api/review-sets/${ID}/items?status=excluded`), ctx)).json()
    expect(body).toMatchObject({ total: 1, rows: [{ idx: 1, excluded_reason: 'wrong category' }] })
  })

  it('filter validates criteria and applies (filter_leads)', async () => {
    h.applyFilter.mockResolvedValue({ filter: { id: 'f2' }, before: { kept: 1 }, after: { kept: 0 } })
    const bad = await filterPOST(req(`/api/review-sets/${ID}/filter`, 'POST', { action: 'exclude', criteria: {} }), ctx)
    expect(bad.status).toBe(400)
    const ok = await filterPOST(req(`/api/review-sets/${ID}/filter`, 'POST', { action: 'exclude', criteria: { missing: ['website'] }, reason: 'no site' }), ctx)
    expect(ok.status).toBe(200)
    expect(h.applyFilter).toHaveBeenCalledWith(set, { missing: ['website'] }, 'exclude', 'no site')
  })

  it('restore undoes a filter (restore_leads)', async () => {
    h.restore.mockResolvedValue({ restored: 1 })
    await restorePOST(req(`/api/review-sets/${ID}/restore`, 'POST', { filter_id: 'f1' }), ctx)
    expect(h.restore).toHaveBeenCalledWith(set, { filter_id: 'f1' })
    expect((await restorePOST(req(`/api/review-sets/${ID}/restore`, 'POST', {}), ctx)).status).toBe(400)
  })

  it('export downloads only kept rows as an Apollo CSV (export_for_apollo)', async () => {
    const res = await exportGET(req(`/api/review-sets/${ID}/export`), ctx)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('apollo-Roofers-Austin-1.csv')
    const text = await res.text()
    expect(text).toContain('Acme Roofing')
    expect(text).not.toContain('Junk LLC')
  })

  it('export refuses when nothing is kept', async () => {
    h.loadRows.mockResolvedValue([{ ...rows[0], status: 'excluded' }])
    expect((await exportGET(req(`/api/review-sets/${ID}/export`), ctx)).status).toBe(422)
  })
})
