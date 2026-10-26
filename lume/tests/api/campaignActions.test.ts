import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Reply / pause / resume / duplicate from the Campaigns screen only create a
 * `pending_actions` row (+ Telegram prompt). Nothing reaches Instantly.
 */

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) } }),
}))

const svc = vi.hoisted(() => ({
  findAwaitingAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
  getPushJob: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...a: unknown[]) => svc[k as keyof typeof svc](...a)])),
  PUSH_REVIEW_STATUSES: ['configuring', 'reviewing_company'],
  isDbError: () => false,
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

    expect(findAwaitingActionBy).toHaveBeenCalledWith(kind, key, value)
    expect(svc.insertPendingAction).toHaveBeenCalledTimes(1)
    const row = svc.insertPendingAction.mock.calls[0][0]
    expect(row).toMatchObject({ kind, requested_by: 'user', payload: { ...payload } })
    expect(row.payload.summary).toBeTruthy()
    expect(sendActionPrompt).toHaveBeenCalledTimes(1)

    // Never touches Instantly (or any network) — the executor does, after confirmation.
    expect(fetchSpy).not.toHaveBeenCalled()
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
})
