import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSheet } from '@/lib/sheets/model'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  getChatFile: vi.fn(), loadParsed: vi.fn(), fileInConversation: vi.fn(),
  createCandidateBatch: vi.fn(), listCandidateBatches: vi.fn(), getCandidateBatch: vi.fn(), listCandidates: vi.fn(), batchCounts: vi.fn(),
  approveCandidates: vi.fn(), rejectCandidates: vi.fn(), existingInfluencerNames: vi.fn(),
  createInfluencerSheet: vi.fn(), sheetsForBatches: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/agent/chatFiles', () => ({ getChatFile: h.getChatFile, loadParsed: h.loadParsed, fileInConversation: h.fileInConversation }))
vi.mock('@/lib/influencers/candidateStore', () => ({
  createCandidateBatch: h.createCandidateBatch, listCandidateBatches: h.listCandidateBatches, getCandidateBatch: h.getCandidateBatch,
  listCandidates: h.listCandidates, batchCounts: h.batchCounts, approveCandidates: h.approveCandidates, rejectCandidates: h.rejectCandidates,
  existingInfluencerNames: h.existingInfluencerNames,
}))
vi.mock('@/lib/db/service', () => ({ isDbError: () => false }))
vi.mock('@/lib/leads/lists/influencerSheets', () => ({ createInfluencerSheet: h.createInfluencerSheet, sheetsForBatches: h.sheetsForBatches }))

import { GET as listGET, POST as importPOST } from '@/app/api/influencers/candidates/route'
import { GET as batchGET } from '@/app/api/influencers/candidates/[id]/route'
import { POST as reviewPOST } from '@/app/api/influencers/candidates/review/route'

const FILE = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const CONV = '1a2b3c4d-1111-4222-8333-444455556666'
const BATCH = '2a2b3c4d-1111-4222-8333-444455556666'
const SHEET_ID = '3a2b3c4d-1111-4222-8333-444455556666'
const post = (url: string, body: unknown) => new Request(`https://lume.test${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const SHEET = buildSheet('People', false, [
  ['Name', 'Title / Role', 'Company / Organization', 'Category', 'Focus / Notes', 'Source Context'],
  ['Sarah Johnson', 'Director', 'Greystar', 'Operator', 'Ops', 'Podcast'],
  ['Peter Lohmann', 'Founder', 'RL PM', '', '', ''],
  ['', 'x', '', '', '', ''],
])

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwner.mockResolvedValue({ ok: true, via: 'internal' })
  h.getChatFile.mockResolvedValue({ id: FILE, name: 'influencers.xlsx' })
  h.loadParsed.mockResolvedValue({ kind: 'xlsx', sheets: [SHEET] })
  h.fileInConversation.mockResolvedValue(true)
  h.existingInfluencerNames.mockResolvedValue([{ id: 'inf-1', name: 'Peter Lohmann' }])
  h.createCandidateBatch.mockImplementation(async (meta) => ({ id: BATCH, ...meta, status: 'staged' }))
  h.createInfluencerSheet.mockResolvedValue({ id: SHEET_ID, name: 'influencers.xlsx · People' })
  h.sheetsForBatches.mockResolvedValue(new Map([[BATCH, SHEET_ID]]))
})

describe('POST /api/influencers/candidates (import)', () => {
  it('stages the sheet (nothing spent), notes names of known influencers, returns the mapping and the lookup estimate', async () => {
    const res = await importPOST(post('/api/influencers/candidates', { file_id: FILE, conversation_id: CONV }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ staged: 2, to_look_up: 2, duplicates: 0, possible_duplicates: 1, skipped_no_name: 1, sheet: 'People', estimate: { people: 2, usd: 0.01, default_cap_usd: 0.1 } })
    expect(body.column_mapping).toMatchObject({ name: 'Name', company: 'Company / Organization' })
    const [meta, rows] = h.createCandidateBatch.mock.calls[0]
    expect(meta).toEqual({ name: 'influencers.xlsx · People', source_file_id: FILE, source_sheet: 'People', conversation_id: CONV })
    // A known name is only a note: Peter is still looked up (a hard duplicate needs the same LinkedIn URL).
    expect(rows.map((r: { name: string; status: string; possible_duplicate_of: string | null }) => [r.name, r.status, r.possible_duplicate_of])).toEqual([
      ['Sarah Johnson', 'pending_lookup', null],
      ['Peter Lohmann', 'pending_lookup', 'inf-1'],
    ])
    expect(h.fileInConversation).toHaveBeenCalledWith(FILE, CONV)
    // The batch is a sheet in Leads (the chat's project folder, else Influencers).
    expect(h.createInfluencerSheet).toHaveBeenCalledWith(expect.objectContaining({ id: BATCH }), 2, CONV)
    expect(body).toMatchObject({ list_id: SHEET_ID, href: `/import/leads?list=${SHEET_ID}` })
  })
  it('404 for a file not attached in that chat; 400 when no name column can be found', async () => {
    h.fileInConversation.mockResolvedValueOnce(false)
    expect((await importPOST(post('/api/influencers/candidates', { file_id: FILE, conversation_id: CONV }))).status).toBe(404)
    h.loadParsed.mockResolvedValueOnce({ kind: 'csv', sheets: [buildSheet('S', false, [['Org'], ['Acme']])] })
    const res = await importPOST(post('/api/influencers/candidates', { file_id: FILE }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/^no_name_column/)
    expect(h.createCandidateBatch).not.toHaveBeenCalled()
  })
})

describe('GET routes', () => {
  it('lists batches; one batch with its candidates, counts and the estimate for what is still pending', async () => {
    h.listCandidateBatches.mockResolvedValue([{ id: BATCH, counts: { pending_lookup: 3 } }])
    expect(await (await listGET(new Request('https://lume.test/api/influencers/candidates'))).json()).toEqual({ batches: [{ id: BATCH, counts: { pending_lookup: 3 }, list_id: SHEET_ID }] })
    h.getCandidateBatch.mockResolvedValue({ id: BATCH, status: 'staged' })
    h.listCandidates.mockResolvedValue([{ id: 'c1' }])
    h.batchCounts.mockResolvedValue({ pending_lookup: 146 })
    const res = await batchGET(new Request(`https://lume.test/api/influencers/candidates/${BATCH}`), { params: Promise.resolve({ id: BATCH }) })
    expect(await res.json()).toMatchObject({ list_id: SHEET_ID, batch: { id: BATCH }, candidates: [{ id: 'c1' }], counts: { pending_lookup: 146 }, estimate: { people: 146, usd: 0.95, default_cap_usd: 1.19 } })
  })
  it('404 for a missing batch', async () => {
    h.getCandidateBatch.mockResolvedValue(null)
    expect((await batchGET(new Request('https://lume.test/x'), { params: Promise.resolve({ id: BATCH }) })).status).toBe(404)
  })
})

describe('POST /api/influencers/candidates/review', () => {
  it('approve and reject by ids', async () => {
    h.approveCandidates.mockResolvedValue({ approved: [{ candidate_id: 'c1', influencer_id: 'i1', created: true }], skipped: [] })
    h.rejectCandidates.mockResolvedValue(2)
    const ids = ['3a2b3c4d-1111-4222-8333-444455556666']
    expect(await (await reviewPOST(post('/api/influencers/candidates/review', { action: 'approve', ids }))).json()).toMatchObject({ approved: [{ influencer_id: 'i1' }] })
    expect(h.approveCandidates).toHaveBeenCalledWith(ids)
    expect(await (await reviewPOST(post('/api/influencers/candidates/review', { action: 'reject', ids }))).json()).toEqual({ rejected: 2 })
    expect((await reviewPOST(post('/api/influencers/candidates/review', { action: 'approve', ids: [] }))).status).toBe(400)
  })
})
