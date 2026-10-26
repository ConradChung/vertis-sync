import { beforeEach, describe, expect, it, vi } from 'vitest'

// Owner gate passes; the route logic is under test.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) } }),
}))

const svc = vi.hoisted(() => ({
  logEvent: vi.fn(),
  pickCampaign: vi.fn(),
  setBarriers: vi.fn(),
  getJobRows: vi.fn(),
  updatePendingRow: vi.fn(),
  getPushJob: vi.fn(),
  findAwaitingAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...a: unknown[]) => svc[k as keyof typeof svc](...a)])),
  PUSH_REVIEW_STATUSES: ['configuring', 'reviewing_company'],
  isDbError: (e: unknown) => e instanceof Error && 'code' in e,
}))

const decide = vi.fn()
vi.mock('@/lib/adapters/pipeline', () => ({ decide: (...a: unknown[]) => decide(...a) }))

const listCampaigns = vi.fn()
let instantlyConfigured = true
vi.mock('@/lib/adapters/instantly', () => ({
  isInstantlyConfigured: () => instantlyConfigured,
  listCampaigns: () => listCampaigns(),
  InstantlyError: class extends Error {},
}))

const getPushPreview = vi.fn()
vi.mock('@/lib/adapters/instantlyPush', () => ({ getPushPreview: (...a: unknown[]) => getPushPreview(...a) }))

const sendActionPrompt = vi.fn()
vi.mock('@/lib/adapters/telegram', () => ({ sendActionPrompt: (...a: unknown[]) => sendActionPrompt(...a) }))

import { POST as decidePOST, maxDuration } from '@/app/api/gates/decide/route'
import { PATCH as barriersPATCH, POST as campaignPOST } from '@/app/api/gates/campaign/[jobId]/route'
import { PATCH as rowsPATCH, GET as rowsGET } from '@/app/api/jobs/[id]/rows/route'
import { POST as actionsPOST } from '@/app/api/actions/route'

const JOB = '7db3d841-252c-4572-95ec-bc110727df8d'
const ROW = '2b1e6f0e-6c1d-4f43-9a6e-1f6f0c9f4a11'
const post = (url: string, body: unknown, method = 'POST') =>
  new Request(`http://localhost${url}`, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const params = <K extends string>(k: K, v: string) => ({ params: Promise.resolve({ [k]: v } as Record<K, string>) })

beforeEach(() => {
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  for (const f of Object.values(svc)) f.mockReset()
  decide.mockReset()
  listCampaigns.mockReset()
  sendActionPrompt.mockReset()
  getPushPreview.mockReset()
  getPushPreview.mockResolvedValue({ ok: true, preview: { ok: true, eligible: 20, filtered: 4 } })
  instantlyConfigured = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/gates/decide', () => {
  it('declares maxDuration 300', () => expect(maxDuration).toBe(300))

  it('403 session_required for the internal bearer (the agent never decides a gate itself)', async () => {
    vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
    const res = await decidePOST(
      new Request('http://localhost/api/gates/decide', {
        method: 'POST',
        body: JSON.stringify({ callback_data: `lfo_count:${JOB}:499` }),
        headers: { 'content-type': 'application/json', authorization: 'Bearer internal-secret' },
      })
    )
    vi.unstubAllEnvs()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'session_required' })
    expect(decide).not.toHaveBeenCalled()
  })

  it('400 on a non-allowlisted action, without calling the entrypoint', async () => {
    const res = await decidePOST(post('/api/gates/decide', { callback_data: `bar_loc:${JOB}` }))
    expect(res.status).toBe(400)
    expect(decide).not.toHaveBeenCalled()
  })

  it.each(['push_go', 'camp_launch', 'lume_ok'])('400 needs_confirmation for %s', async (a) => {
    const res = await decidePOST(post('/api/gates/decide', { callback_data: `${a}:${JOB}` }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'needs_confirmation' })
    expect(decide).not.toHaveBeenCalled()
  })

  it('400 on an out-of-range lfo_count', async () => {
    const res = await decidePOST(post('/api/gates/decide', { callback_data: `lfo_count:${JOB}:499` }))
    expect(res.status).toBe(400)
  })

  it('409 already_handled when claimed=false, and logs lume.decision', async () => {
    decide.mockResolvedValue({ ok: true, claimed: false, action: 'deny', target_id: JOB })
    const res = await decidePOST(post('/api/gates/decide', { callback_data: `deny:${JOB}` }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'already_handled' })
    expect(svc.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lume.decision', source: 'lume', source_id: JOB, title: 'deny from Lume', payload: { claimed: false, action: 'deny' } })
    )
  })

  it('200 on claimed true / null', async () => {
    decide.mockResolvedValue({ ok: true, claimed: null, action: 'jobs_abort', target_id: JOB })
    const res = await decidePOST(post('/api/gates/decide', { callback_data: `jobs_abort:${JOB}` }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, claimed: null })
  })

  it('202 pending on a timeout/abort, no event', async () => {
    decide.mockResolvedValue({ ok: false, status: 0, error: 'timeout' })
    const res = await decidePOST(post('/api/gates/decide', { callback_data: `approve:${JOB}` }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ pending: true })
    expect(svc.logEvent).not.toHaveBeenCalled()
  })

  it('502 generic on an entrypoint error', async () => {
    decide.mockResolvedValue({ ok: false, status: 500, error: 'secret detail' })
    const res = await decidePOST(post('/api/gates/decide', { callback_data: `approve:${JOB}` }))
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })

  it('a failing logEvent does not turn a decision into an error', async () => {
    decide.mockResolvedValue({ ok: true, claimed: true, action: 'deny', target_id: JOB })
    svc.logEvent.mockRejectedValue(new Error('db down'))
    const res = await decidePOST(post('/api/gates/decide', { callback_data: `deny:${JOB}` }))
    expect(res.status).toBe(200)
  })
})

describe('/api/gates/campaign/[jobId]', () => {
  it('POST 409 when the conditional PATCH matched nothing (gate moved on)', async () => {
    listCampaigns.mockResolvedValue([{ id: 'c1', name: 'Kaspen R3', status: 1, statusLabel: 'active' }])
    svc.pickCampaign.mockResolvedValue(false)
    const res = await campaignPOST(post(`/api/gates/campaign/${JOB}`, { campaign_id: 'c1', campaign_name: 'x' }), params('jobId', JOB))
    expect(res.status).toBe(409)
    expect(svc.pickCampaign).toHaveBeenCalledWith(JOB, { id: 'c1', name: 'Kaspen R3' }) // name from Instantly, not the client
    expect(svc.logEvent).not.toHaveBeenCalled()
  })

  it('POST 200 on a pick; logs lume.campaign_pick', async () => {
    listCampaigns.mockResolvedValue([{ id: 'c1', name: 'Kaspen R3', status: 1, statusLabel: 'active' }])
    svc.pickCampaign.mockResolvedValue(true)
    const res = await campaignPOST(post(`/api/gates/campaign/${JOB}`, { campaign_id: 'c1' }), params('jobId', JOB))
    expect(res.status).toBe(200)
    expect(svc.logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'lume.campaign_pick' }))
  })

  it('POST 400 for an unknown campaign or when Instantly is not configured', async () => {
    listCampaigns.mockResolvedValue([])
    expect((await campaignPOST(post(`/api/gates/campaign/${JOB}`, { campaign_id: 'zz' }), params('jobId', JOB))).status).toBe(400)
    instantlyConfigured = false
    expect((await campaignPOST(post(`/api/gates/campaign/${JOB}`, { campaign_id: 'c1' }), params('jobId', JOB))).status).toBe(400)
    expect(svc.pickCampaign).not.toHaveBeenCalled()
  })

  it('POST 400 on a bad job id', async () => {
    expect((await campaignPOST(post('/api/gates/campaign/x', { campaign_id: 'c1' }), params('jobId', 'x'))).status).toBe(400)
  })

  it('PATCH barriers: 409 outside configuring, 400 on unknown keys', async () => {
    svc.setBarriers.mockResolvedValue('moved')
    const res = await barriersPATCH(post(`/api/gates/campaign/${JOB}`, { location_barrier: true }, 'PATCH'), params('jobId', JOB))
    expect(res.status).toBe(409)
    svc.setBarriers.mockResolvedValue('push_awaiting_confirmation')
    const locked = await barriersPATCH(post(`/api/gates/campaign/${JOB}`, { company_strict: true }, 'PATCH'), params('jobId', JOB))
    expect(locked.status).toBe(409)
    expect(await locked.json()).toEqual({ error: 'push_awaiting_confirmation' })
    const bad = await barriersPATCH(post(`/api/gates/campaign/${JOB}`, { instantly_status: 'pushing' }, 'PATCH'), params('jobId', JOB))
    expect(bad.status).toBe(400)
  })
})

describe('/api/jobs/[id]/rows', () => {
  it('PATCH 409 when the row is no longer pending', async () => {
    svc.updatePendingRow.mockResolvedValue({ ok: false, reason: 'not_pending' })
    const res = await rowsPATCH(post(`/api/jobs/${JOB}/rows`, { row_id: ROW, email: 'A@X.com' }, 'PATCH'), params('id', JOB))
    expect(res.status).toBe(409)
    expect(svc.updatePendingRow).toHaveBeenCalledWith(JOB, ROW, { email: 'a@x.com', row_data_patch: undefined })
    expect(svc.logEvent).not.toHaveBeenCalled()
  })

  it('PATCH 409 job_running once the validator may be running', async () => {
    svc.updatePendingRow.mockResolvedValue({ ok: false, reason: 'job_running' })
    const res = await rowsPATCH(post(`/api/jobs/${JOB}/rows`, { row_id: ROW, email: 'a@x.com' }, 'PATCH'), params('id', JOB))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'job_running' })
  })

  it('PATCH 200 logs lume.row_edit without the email value', async () => {
    svc.updatePendingRow.mockResolvedValue({
      ok: true,
      row: { row_index: 7 },
      emailChanged: true,
      fields: ['First Name'],
    })
    const res = await rowsPATCH(
      post(`/api/jobs/${JOB}/rows`, { row_id: ROW, email: 'secret@x.com', row_data_patch: { 'First Name': 'Ann' } }, 'PATCH'),
      params('id', JOB)
    )
    expect(res.status).toBe(200)
    const ev = svc.logEvent.mock.calls[0][0]
    expect(ev).toMatchObject({ type: 'lume.row_edit', title: 'Row 7 edited in Lume' })
    expect(JSON.stringify(ev)).not.toContain('secret@x.com')
  })

  it('PATCH 400 on a bad email or empty edit', async () => {
    expect((await rowsPATCH(post(`/api/jobs/${JOB}/rows`, { row_id: ROW, email: 'nope' }, 'PATCH'), params('id', JOB))).status).toBe(400)
    expect((await rowsPATCH(post(`/api/jobs/${JOB}/rows`, { row_id: ROW }, 'PATCH'), params('id', JOB))).status).toBe(400)
  })

  it('GET pages from 0 and rejects junk', async () => {
    svc.getJobRows.mockResolvedValue({ rows: [], total: 0, page: 2, pageSize: 100 })
    expect((await rowsGET(new Request(`http://localhost/api/jobs/${JOB}/rows?page=2`), params('id', JOB))).status).toBe(200)
    expect(svc.getJobRows).toHaveBeenCalledWith(JOB, 2)
    expect((await rowsGET(new Request(`http://localhost/api/jobs/${JOB}/rows?page=-1`), params('id', JOB))).status).toBe(400)
  })
})

describe('POST /api/actions', () => {
  const job = {
    id: JOB,
    filename: 'apify.csv',
    valid_count: 24,
    instantly_status: 'configuring',
    instantly_campaign_id: 'c1',
    instantly_campaign_name: 'Kaspen R3',
    location_barrier: false,
    company_barrier: true,
    company_strict: false,
    instantly_pushed: null,
  }

  it('409 duplicate when an awaiting action of the same kind exists for the job', async () => {
    svc.getPushJob.mockResolvedValue(job)
    svc.findAwaitingAction.mockResolvedValue({ id: 'existing-id' })
    const res = await actionsPOST(post('/api/actions', { kind: 'push_to_instantly', payload: { job_id: JOB.toUpperCase() } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'duplicate', existing_id: 'existing-id' })
    expect(svc.findAwaitingAction).toHaveBeenCalledWith('push_to_instantly', JOB) // lowercased
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('201 creates the row with a server-built summary and prompts Telegram', async () => {
    svc.getPushJob.mockResolvedValue(job)
    svc.findAwaitingAction.mockResolvedValue(null)
    svc.insertPendingAction.mockImplementation(async (r: Record<string, unknown>) => ({ id: 'a1', ...r }))
    sendActionPrompt.mockResolvedValue({ ok: true, messageId: 99 })
    const res = await actionsPOST(post('/api/actions', { kind: 'push_to_instantly', payload: { job_id: JOB, summary: 'lies' } }))
    expect(res.status).toBe(201)
    const inserted = svc.insertPendingAction.mock.calls[0][0]
    expect(inserted).toMatchObject({ kind: 'push_to_instantly', requested_by: 'user', payload: { job_id: JOB } })
    expect(inserted.payload).toMatchObject({
      job_id: JOB,
      campaign_id: 'c1',
      location_barrier: false,
      company_barrier: true,
      company_strict: false,
      eligible: 20,
    })
    expect(inserted.payload.summary).toContain('Push 20 leads from apify.csv → Kaspen R3 (4 filtered')
    expect(inserted.payload.summary).not.toContain('lies')
    expect(svc.setActionMessageId).toHaveBeenCalledWith('a1', 99)
  })

  it('Telegram unconfigured: still 201, no message id stored', async () => {
    svc.getPushJob.mockResolvedValue(job)
    svc.findAwaitingAction.mockResolvedValue(null)
    svc.insertPendingAction.mockImplementation(async (r: Record<string, unknown>) => ({ id: 'a1', ...r }))
    sendActionPrompt.mockResolvedValue({ ok: false, skipped: true })
    const res = await actionsPOST(post('/api/actions', { kind: 'push_to_instantly', payload: { job_id: JOB } }))
    expect(res.status).toBe(201)
    expect(svc.setActionMessageId).not.toHaveBeenCalled()
  })

  it('409 job_not_ready when the job is not in push review', async () => {
    svc.getPushJob.mockResolvedValue({ ...job, instantly_status: 'pushing' })
    const res = await actionsPOST(post('/api/actions', { kind: 'push_to_instantly', payload: { job_id: JOB } }))
    expect(res.status).toBe(409)
  })

  it('409 nothing_to_push when the preview has 0 eligible', async () => {
    svc.getPushJob.mockResolvedValue(job)
    getPushPreview.mockResolvedValue({ ok: true, preview: { ok: true, eligible: 0, filtered: 24 } })
    const res = await actionsPOST(post('/api/actions', { kind: 'push_to_instantly', payload: { job_id: JOB } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'nothing_to_push' })
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('a unique-index violation (23505) is a duplicate, not a 500', async () => {
    svc.getPushJob.mockResolvedValue(job)
    svc.findAwaitingAction.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' })
    svc.insertPendingAction.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await actionsPOST(post('/api/actions', { kind: 'push_to_instantly', payload: { job_id: JOB } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'duplicate', existing_id: 'winner' })
  })

  it('launch_campaign needs instantly_status done and pushed > 0', async () => {
    svc.getPushJob.mockResolvedValue({ ...job, instantly_status: 'configuring', instantly_pushed: 0 })
    expect((await actionsPOST(post('/api/actions', { kind: 'launch_campaign', payload: { job_id: JOB } }))).status).toBe(409)
    svc.getPushJob.mockResolvedValue({ ...job, instantly_status: 'done', instantly_pushed: 0 })
    expect((await actionsPOST(post('/api/actions', { kind: 'launch_campaign', payload: { job_id: JOB } }))).status).toBe(409)
    svc.getPushJob.mockResolvedValue({ ...job, instantly_status: 'done', instantly_pushed: 12 })
    svc.findAwaitingAction.mockResolvedValue(null)
    svc.insertPendingAction.mockImplementation(async (r: Record<string, unknown>) => ({ id: 'a2', ...r }))
    sendActionPrompt.mockResolvedValue({ ok: false, skipped: true })
    expect((await actionsPOST(post('/api/actions', { kind: 'launch_campaign', payload: { job_id: JOB } }))).status).toBe(201)
  })

  it('400 for kinds this task does not accept', async () => {
    const res = await actionsPOST(post('/api/actions', { kind: 'send_reply', payload: { job_id: JOB } }))
    expect(res.status).toBe(400)
  })
})
