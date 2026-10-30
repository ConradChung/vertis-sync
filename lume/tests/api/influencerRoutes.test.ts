import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  listInfluencers: vi.fn(),
  listRuns: vi.fn(),
  getInfluencersBySlugs: vi.fn(),
  apifyMonthSpend: vi.fn(),
  exportCandidates: vi.fn(),
  createExport: vi.fn(),
  influencerNames: vi.fn(),
  getExport: vi.fn(),
  exportRows: vi.fn(),
  insertInfluencer: vi.fn(),
  callInfluencerFn: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/influencers/store', () => ({
  listInfluencers: h.listInfluencers,
  listRuns: h.listRuns,
  getInfluencersBySlugs: h.getInfluencersBySlugs,
  apifyMonthSpend: h.apifyMonthSpend,
  exportCandidates: h.exportCandidates,
  createExport: h.createExport,
  influencerNames: h.influencerNames,
  getExport: h.getExport,
  exportRows: h.exportRows,
  insertInfluencer: h.insertInfluencer,
  DuplicateInfluencerError: class extends Error {},
}))
vi.mock('@/lib/adapters/influencerFn', () => ({ callInfluencerFn: h.callInfluencerFn }))

import { POST as exportPOST } from '@/app/api/influencers/exports/route'
import { GET as exportGET } from '@/app/api/influencers/exports/[id]/route'
import { GET as estimateGET } from '@/app/api/influencers/estimate/route'
import { POST as addPOST } from '@/app/api/influencers/route'
import { POST as cancelPOST } from '@/app/api/influencers/runs/[id]/cancel/route'

const EXP = '55555555-5555-4555-8555-555555555555'
const RUN = '33333333-3333-4333-8333-333333333333'
const reactor = (id: number, doors: number | null) => ({
  id, name: `Owner ${id}`, linkedin_url: `https://www.linkedin.com/in/r${id}`, title: 'Owner', company_name: `PM ${id}`,
  company_website: `https://pm${id}.com`, location: 'Austin, TX', city: null, state: null, country: null, door_count: doors, reacted_to: ['peter-lohmann'],
})
const post = (url: string, body: unknown) => new Request(url, { method: 'POST', body: JSON.stringify(body) })
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never

beforeEach(() => {
  vi.resetAllMocks()
  h.requireOwner.mockResolvedValue({ ok: true })
  h.influencerNames.mockResolvedValue({ 'peter-lohmann': 'Peter Lohmann' })
})

describe('POST /api/influencers/exports', () => {
  it('records the export with the filters (verified only by default) and returns the link and Apollo steps', async () => {
    h.exportCandidates.mockResolvedValue([reactor(1, 900), reactor(2, 750)])
    h.createExport.mockResolvedValue({ id: EXP, created_at: '2026-10-30T00:00:00Z' })
    const res = await exportPOST(post('http://x/api/influencers/exports', { min_door_count: 700, only_new: true, reacted_to_column: true }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(h.exportCandidates).toHaveBeenCalledWith({ verified_only: true, min_door_count: 700, only_new: true, reacted_to_column: true })
    expect(h.createExport.mock.calls[0][1]).toEqual([1, 2])
    expect(body).toMatchObject({ export_id: EXP, rows: 2, at_700_plus: 2, download: `/api/influencers/exports/${EXP}` })
    expect(body.columns.at(-1)).toBe('Reacted To')
    expect(body.steps.at(-1)).toMatch(/Leadsfriday/)
  })
  it('422 when nothing matches; 400 on unknown fields', async () => {
    h.exportCandidates.mockResolvedValue([])
    expect((await exportPOST(post('http://x/api/influencers/exports', { only_new: true }))).status).toBe(422)
    expect((await exportPOST(post('http://x/api/influencers/exports', { min_doors: 700 }))).status).toBe(400)
    expect(h.createExport).not.toHaveBeenCalled()
  })
  it('refuses without the owner', async () => {
    h.requireOwner.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) })
    expect((await exportPOST(post('http://x/api/influencers/exports', {}))).status).toBe(401)
  })
})

describe('GET /api/influencers/exports/<id>', () => {
  it('downloads the Apollo CSV in the export\'s order', async () => {
    h.getExport.mockResolvedValue({ id: EXP, filters: { door_count_column: true }, reactor_ids: [2, 1], row_count: 2, created_at: '2026-10-30T01:00:00Z' })
    h.exportRows.mockResolvedValue([reactor(2, 750), reactor(1, 900)])
    const res = await exportGET(new Request(`http://x/api/influencers/exports/${EXP}`), ctx({ id: EXP }))
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="pm-influencer-leads-2026-10-30-2.csv"')
    const lines = (await res.text()).trimEnd().split('\n')
    expect(lines[0]).toBe('First Name,Last Name,Title,Company,Website,Person Linkedin Url,City,State,Country,Door Count')
    expect(lines[1]).toBe('Owner,2,Owner,PM 2,pm2.com,https://www.linkedin.com/in/r2,Austin,TX,United States,750')
    expect(h.exportRows).toHaveBeenCalledWith([2, 1])
  })
  it('404 unknown export, 400 bad id', async () => {
    h.getExport.mockResolvedValue(null)
    expect((await exportGET(new Request('http://x'), ctx({ id: EXP }))).status).toBe(404)
    expect((await exportGET(new Request('http://x'), ctx({ id: 'nope' }))).status).toBe(400)
  })
})

describe('GET /api/influencers/estimate', () => {
  it('404 lists unknown slugs; 400 on a bad cap', async () => {
    h.getInfluencersBySlugs.mockResolvedValue([])
    const res = await estimateGET(new Request('http://x/api/influencers/estimate?slugs=nobody'))
    expect(res.status).toBe(404)
    expect((await res.json()).unknown).toEqual(['nobody'])
    expect((await estimateGET(new Request('http://x/api/influencers/estimate?max_verify_usd=99'))).status).toBe(400)
  })
})

describe('POST /api/influencers', () => {
  it('derives the slug from the name and strips the trailing slash', async () => {
    h.insertInfluencer.mockImplementation(async (row: unknown) => row)
    const res = await addPOST(post('http://x/api/influencers', { name: 'Jennifer Ruelens (PM Jen)', linkedin_url: 'https://www.linkedin.com/in/jenniferruelens/' }))
    expect(res.status).toBe(201)
    expect(h.insertInfluencer.mock.calls[0][0]).toMatchObject({ slug: 'jennifer-ruelens', linkedin_url: 'https://www.linkedin.com/in/jenniferruelens' })
  })
})

describe('POST /api/influencers/runs/<id>/cancel', () => {
  it('asks the edge function to cancel; 409 passes through', async () => {
    h.callInfluencerFn.mockResolvedValue({ ok: true, status: 200, body: { ok: true, aborted: 1 } })
    expect(await (await cancelPOST(new Request('http://x', { method: 'POST' }), ctx({ id: RUN }))).json()).toEqual({ ok: true, aborted: 1 })
    expect(h.callInfluencerFn).toHaveBeenCalledWith({ action: 'cancel', run_id: RUN })
    h.callInfluencerFn.mockResolvedValue({ ok: false, status: 409, error: 'not_active' })
    expect((await cancelPOST(new Request('http://x', { method: 'POST' }), ctx({ id: RUN }))).status).toBe(409)
  })
})
