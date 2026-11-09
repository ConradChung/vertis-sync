import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/campaigns/suggest is read-only; POST /api/campaigns/new only files
 * a `new_campaign` pending action (+ approval prompt). Nothing reaches Instantly.
 */

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))

const svc = vi.hoisted(() => ({
  findAwaitingAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...a: unknown[]) => svc[k as keyof typeof svc](...a)])),
  PUSH_REVIEW_STATUSES: ['configuring', 'reviewing_company'],
  CAMPAIGN_CHOICE_STATUSES: ['awaiting_campaign', 'choosing_campaign'],
  isDbError: (e: unknown) => !!e && typeof e === 'object' && 'code' in e,
  DbError: class extends Error {},
}))
const findAwaitingActionBy = vi.fn()
vi.mock('@/lib/campaigns/service', () => ({ findAwaitingActionBy: (...a: unknown[]) => findAwaitingActionBy(...a) }))
const sendActionPrompt = vi.fn()
vi.mock('@/lib/adapters/telegram', () => ({ sendActionPrompt: (...a: unknown[]) => sendActionPrompt(...a), sendMessage: vi.fn() }))
const buildNewCampaign = vi.fn()
vi.mock('@/lib/campaigns/newCampaign', () => ({ buildNewCampaign: (...a: unknown[]) => buildNewCampaign(...a) }))
const getCampaignSuggestion = vi.fn()
vi.mock('@/lib/campaigns/suggestData', () => ({ getCampaignSuggestion: (...a: unknown[]) => getCampaignSuggestion(...a) }))

import { POST } from '@/app/api/campaigns/new/route'
import { GET } from '@/app/api/campaigns/suggest/route'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/campaigns/new', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
const BUILT = {
  ok: true,
  kind: 'new_campaign',
  payload: {
    name: 'Kaspen — PM owners — Nov 2026',
    name_key: 'kaspen — pm owners — nov 2026',
    sequences: [{ steps: [{ variants: [{ subject: 'a', body: 'b' }] }] }],
    email_list: ['a@send.com'],
    campaign_schedule: { schedules: [{ name: 'W', timing: { from: '09:00', to: '17:00' }, days: { '1': true }, timezone: 'America/Chicago' }] },
    daily_limit: 50,
    stop_on_reply: true,
    summary: 'New campaign “Kaspen — PM owners — Nov 2026”…',
  },
}

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  for (const f of Object.values(svc)) f.mockReset()
  findAwaitingActionBy.mockReset().mockResolvedValue(null)
  sendActionPrompt.mockReset().mockResolvedValue({ ok: true, messageId: null })
  buildNewCampaign.mockReset().mockResolvedValue(BUILT)
  getCampaignSuggestion.mockReset()
  svc.findAwaitingAction.mockResolvedValue(null)
  svc.insertPendingAction.mockImplementation(async (row: { kind: string; payload: unknown }) => ({ id: 'act-1', status: 'awaiting', ...row }))
  fetchSpy = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchSpy)
})

describe('POST /api/campaigns/new', () => {
  it('files a new_campaign pending action; nothing is called in Instantly', async () => {
    const res = await post({ name: 'x', template_id: JOB, email_list: ['a@send.com'] })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, action: { id: 'act-1', kind: 'new_campaign', summary: BUILT.payload.summary } })
    expect(buildNewCampaign).toHaveBeenCalledWith({ name: 'x', template_id: JOB, email_list: ['a@send.com'] })
    expect(svc.insertPendingAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'new_campaign', requested_by: 'user' }))
    expect(findAwaitingActionBy).toHaveBeenCalledWith('new_campaign', 'name_key', 'kaspen — pm owners — nov 2026')
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('instantly'))).toBe(false)
  })

  it('a builder refusal is passed through with its problems', async () => {
    buildNewCampaign.mockResolvedValue({ ok: false, status: 400, error: 'unknown_inboxes', problems: ['z@nope.com'] })
    const res = await post({})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown_inboxes', problems: ['z@nope.com'] })
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('the same name already awaiting → 409 duplicate with its id', async () => {
    findAwaitingActionBy.mockResolvedValue({ id: 'act-0' })
    const res = await post({})
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'duplicate', existing_id: 'act-0' })
  })

  it('with job_id: one awaiting per job', async () => {
    buildNewCampaign.mockResolvedValue({ ...BUILT, payload: { ...BUILT.payload, job_id: JOB } })
    svc.findAwaitingAction.mockResolvedValue({ id: 'act-j' })
    const res = await post({})
    expect(res.status).toBe(409)
    expect(svc.findAwaitingAction).toHaveBeenCalledWith('new_campaign', JOB)
  })
})

describe('GET /api/campaigns/suggest', () => {
  const get = (q = '') => GET(new Request(`http://localhost/api/campaigns/suggest${q}`))
  it('job_id / list_id / none', async () => {
    getCampaignSuggestion.mockResolvedValue({ suggestion: { name: 'n' } })
    expect((await get(`?job_id=${JOB.toUpperCase()}`)).status).toBe(200)
    expect(getCampaignSuggestion).toHaveBeenLastCalledWith({ job_id: JOB }, { withSources: true })
    await get(`?list_id=${JOB}&sources=0`)
    expect(getCampaignSuggestion).toHaveBeenLastCalledWith({ list_id: JOB }, { withSources: false })
    await get()
    expect(getCampaignSuggestion).toHaveBeenLastCalledWith(null, { withSources: true })
  })
  it('bad ids → 400, unknown source → 404', async () => {
    expect((await get('?job_id=nope')).status).toBe(400)
    expect((await get(`?job_id=${JOB}&list_id=${JOB}`)).status).toBe(400)
    getCampaignSuggestion.mockResolvedValue(null)
    expect((await get(`?job_id=${JOB}`)).status).toBe(404)
  })
})
