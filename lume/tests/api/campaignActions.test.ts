import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Reply / pause / resume / duplicate from the Campaigns screen only create a
 * `pending_actions` row (+ Telegram prompt). Nothing reaches Instantly.
 */

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))

const svc = vi.hoisted(() => ({
  findAwaitingAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
  getPushJob: vi.fn(),
  getCampaignByExternalId: vi.fn(),
  getInstantlyEmailEvent: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...a: unknown[]) => svc[k as keyof typeof svc](...a)])),
  PUSH_REVIEW_STATUSES: ['configuring', 'reviewing_company'],
  isDbError: (e: unknown) => !!e && typeof e === 'object' && 'code' in e,
  DbError: class extends Error {},
}))
const findAwaitingActionBy = vi.fn()
vi.mock('@/lib/campaigns/service', () => ({ findAwaitingActionBy: (...a: unknown[]) => findAwaitingActionBy(...a) }))
const sendActionPrompt = vi.fn()
vi.mock('@/lib/adapters/telegram', () => ({ sendActionPrompt: (...a: unknown[]) => sendActionPrompt(...a) }))
const getPushPreview = vi.fn()
vi.mock('@/lib/adapters/instantlyPush', () => ({ getPushPreview: (...a: unknown[]) => getPushPreview(...a) }))

import { POST } from '@/app/api/actions/route'

const CID = '0b6c6d2e-1111-4222-8333-444455556666'
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/actions', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  process.env.INSTANTLY_API_KEY = 'k'
  for (const f of Object.values(svc)) f.mockReset()
  findAwaitingActionBy.mockReset().mockResolvedValue(null)
  sendActionPrompt.mockReset().mockResolvedValue({ ok: true, messageId: null })
  getPushPreview.mockReset()
  svc.getCampaignByExternalId.mockResolvedValue({ name: 'Kaspen PM' })
  svc.getInstantlyEmailEvent.mockResolvedValue({ lead_email: 'lead@x.com', campaign_id: CID })
  svc.insertPendingAction.mockImplementation(async (row: { kind: string; payload: unknown }) => ({ id: 'act-1', ...row }))
  fetchSpy = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_KEY
})

const cases = [
  [
    'send_reply',
    { campaign_id: CID, eaccount: 'me@send.com', reply_to_uuid: 'e2', body: 'Thanks — Tuesday works.', subject: 'Re: Hi', lead_email: 'lead@x.com' },
    'reply_to_uuid',
    'e2',
  ],
  ['pause_campaign', { campaign_id: CID, campaign_name: 'Kaspen PM' }, 'campaign_id', CID],
  ['resume_campaign', { campaign_id: CID }, 'campaign_id', CID],
  ['create_campaign', { source_campaign_id: CID, name: 'Kaspen PM (copy)' }, 'source_campaign_id', CID],
] as const

describe('POST /api/actions — campaign kinds', () => {
  it.each(cases)('%s → 201 pending action, Telegram prompt, no Instantly call', async (kind, payload, key, value) => {
    const res = await post({ kind, payload })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, action: { id: 'act-1', kind } })
    expect(typeof body.action.summary).toBe('string')

    if (kind === 'send_reply') {
      // One reply per inbound message: an executed or in-flight reply blocks too (pending_actions_one_reply_per_inbound_idx).
      expect(findAwaitingActionBy).toHaveBeenCalledWith(kind, key, value, ['awaiting', 'approved', 'executing', 'executed'])
    } else {
      expect(findAwaitingActionBy).toHaveBeenCalledWith(kind, key, value)
    }
    expect(svc.insertPendingAction).toHaveBeenCalledTimes(1)
    const row = svc.insertPendingAction.mock.calls[0][0]
    expect(row).toMatchObject({ kind, requested_by: 'user', payload: { ...payload, campaign_name: 'Kaspen PM' } })
    expect(row.payload.summary).toBeTruthy()
    expect(sendActionPrompt).toHaveBeenCalledTimes(1)

    // Names come from lume_campaigns / the email event; send_reply also reads the
    // email from Instantly (GET /emails/<id>, cached). Nothing is ever written.
    for (const [url, init] of fetchSpy.mock.calls as unknown as [string, RequestInit | undefined][]) {
      expect(init?.method ?? 'GET').toBe('GET')
      expect(kind === 'send_reply' && url.includes('/api/v2/emails/')).toBe(true)
    }
  })

  it('409 when the same action is already awaiting', async () => {
    findAwaitingActionBy.mockResolvedValue({ id: 'old' })
    const res = await post({ kind: 'pause_campaign', payload: { campaign_id: CID } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'duplicate', existing_id: 'old' })
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it.each([
    ['send_reply without body', { kind: 'send_reply', payload: { campaign_id: CID, eaccount: 'me@send.com', reply_to_uuid: 'e2', body: '  ' } }],
    ['send_reply with a bad eaccount', { kind: 'send_reply', payload: { campaign_id: CID, eaccount: 'nope', reply_to_uuid: 'e2', body: 'hi' } }],
    ['create_campaign without name', { kind: 'create_campaign', payload: { source_campaign_id: CID } }],
    ['pause without campaign', { kind: 'pause_campaign', payload: {} }],
    ['unknown kind', { kind: 'delete_everything', payload: { campaign_id: CID } }],
  ])('400 on %s, nothing created', async (_n, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('job kinds keep requiring a job (unchanged path)', async () => {
    const res = await post({ kind: 'launch_campaign', payload: { campaign_id: CID } })
    expect(res.status).toBe(400)
  })

  it('send_reply without campaign_id is fine (extras optional); client summary is ignored; unknown keys dropped', async () => {
    const res = await post({
      kind: 'send_reply',
      payload: { eaccount: 'me@send.com', reply_to_uuid: 'e9', body: 'hi', summary: 'Delete everything', evil: 1, to: 'lead@x.com' },
    })
    expect(res.status).toBe(201)
    const row = svc.insertPendingAction.mock.calls[0][0]
    expect(svc.getInstantlyEmailEvent).toHaveBeenCalledWith('e9')
    expect(row.payload).toEqual({
      eaccount: 'me@send.com',
      reply_to_uuid: 'e9',
      body: 'hi',
      lead_email: 'lead@x.com',
      recipient_verified: true,
      campaign_id: CID,
      campaign_name: 'Kaspen PM',
      summary: expect.stringContaining('Send reply to lead@x.com from me@send.com (Kaspen PM)'),
    })
  })

  it('campaign_name is looked up server-side; a caller-supplied one is ignored', async () => {
    svc.getCampaignByExternalId.mockResolvedValue({ name: 'Real Name' })
    const res = await post({ kind: 'pause_campaign', payload: { campaign_id: CID, campaign_name: 'Harmless test campaign' } })
    expect(res.status).toBe(201)
    const row = svc.insertPendingAction.mock.calls[0][0]
    expect(svc.getCampaignByExternalId).toHaveBeenCalledWith(CID)
    expect(row.payload.campaign_name).toBe('Real Name')
    expect(row.payload.summary).toBe('Pause campaign Real Name')
    expect(row.payload.summary).not.toContain('Harmless')
  })

  it('unknown campaign everywhere → the id; Instantly is only read (GET), never written', async () => {
    svc.getCampaignByExternalId.mockResolvedValue(null)
    const res = await post({ kind: 'resume_campaign', payload: { campaign_id: CID, campaign_name: 'Fake' } })
    expect(res.status).toBe(201)
    expect(svc.insertPendingAction.mock.calls[0][0].payload.summary).toBe(`Resume campaign ${CID}`)
    for (const [, init] of fetchSpy.mock.calls as unknown as [string, RequestInit | undefined][]) {
      expect(init?.method ?? 'GET').toBe('GET')
    }
  })

  it('send_reply whose recipient no lookup knows is marked unverified (the caller claim is kept, flagged)', async () => {
    svc.getInstantlyEmailEvent.mockResolvedValue(null)
    const res = await post({
      kind: 'send_reply',
      payload: { eaccount: 'me@send.com', reply_to_uuid: 'e10', body: 'hi', lead_email: 'boss@corp.com' },
    })
    expect(res.status).toBe(201)
    const p = svc.insertPendingAction.mock.calls[0][0].payload
    expect(p.recipient_verified).toBe(false)
    expect(p.lead_email).toBe('boss@corp.com')
    expect(p.summary).toContain('to boss@corp.com (unverified)')
    for (const [, init] of fetchSpy.mock.calls as unknown as [string, RequestInit | undefined][]) {
      expect(init?.method ?? 'GET').toBe('GET')
    }
  })

  it('send_reply to an inbound message already answered → 409 duplicate pointing at the earlier reply', async () => {
    findAwaitingActionBy.mockResolvedValue({ id: 'sent-before', status: 'executed' })
    const res = await post({ kind: 'send_reply', payload: { eaccount: 'me@send.com', reply_to_uuid: 'e2', body: 'again' } })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('sent-before')
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('23505 from the campaign unique index → 409 duplicate', async () => {
    findAwaitingActionBy.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' })
    svc.insertPendingAction.mockRejectedValue({ code: '23505' })
    const res = await post({ kind: 'resume_campaign', payload: { campaign_id: CID } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'duplicate', existing_id: 'winner' })
    expect(sendActionPrompt).not.toHaveBeenCalled()
  })

  it('internal bearer → requested_by agent', async () => {
    process.env.LUME_INTERNAL_SECRET = 'tok-123456789012345678901234567890'
    const res = await POST(
      new Request('http://localhost/api/actions', {
        method: 'POST',
        body: JSON.stringify({ kind: 'pause_campaign', payload: { campaign_id: CID } }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LUME_INTERNAL_SECRET}` },
      })
    )
    delete process.env.LUME_INTERNAL_SECRET
    expect(res.status).toBe(201)
    expect(svc.insertPendingAction.mock.calls[0][0].requested_by).toBe('agent')
  })
})
