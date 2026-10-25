import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingActionRow } from '@/lib/db/types'

// Every side effect is mocked: no DB, no Telegram, no Instantly, no pipeline.
const store = vi.hoisted(() => ({
  claimExecution: vi.fn(),
  finishAction: vi.fn(),
  getAction: vi.fn(),
  getStaleApprovedIds: vi.fn(),
  insertQueuedLeads: vi.fn(),
  getRule: vi.fn(),
  activateRule: vi.fn(),
  deleteRule: vi.fn(),
  claimDecision: vi.fn(),
}))
vi.mock('@/lib/actions/store', () => store)

const svc = vi.hoisted(() => ({
  getPushJob: vi.fn(),
  logEvent: vi.fn(),
  findAwaitingAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...svc,
  PUSH_REVIEW_STATUSES: ['configuring', 'reviewing_company'],
  isDbError: (e: unknown) => e instanceof Error && 'code' in e,
}))
vi.mock('@/lib/adapters/instantlyPush', () => ({ getPushPreview: vi.fn() }))

const decide = vi.hoisted(() => vi.fn())
vi.mock('@/lib/adapters/pipeline', () => ({ decide }))

const ins = vi.hoisted(() => ({
  getCampaignDetail: vi.fn(),
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  sendReply: vi.fn(),
  createCampaignFrom: vi.fn(),
}))
vi.mock('@/lib/adapters/instantlyWrite', () => ins)

const tg = vi.hoisted(() => ({ sendMessage: vi.fn(), editMessage: vi.fn(), sendDecisionNote: vi.fn(), sendActionPrompt: vi.fn() }))
vi.mock('@/lib/adapters/telegram', () => tg)

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) } }),
}))

import { EXECUTABLE_KINDS, executeAction, sweepStuckActions } from '@/lib/actions/execute'
import { POST as decidePOST, maxDuration } from '@/app/api/actions/[id]/decide/route'
import { POST as executePOST } from '@/app/api/actions/[id]/execute/route'
import { POST as createPOST } from '@/app/api/actions/route'

const ID = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const JOB = '7db3d841-252c-4572-95ec-bc110727df8d'
const RULE = '2b1e6f0e-6c1d-4f43-9a6e-1f6f0c9f4a11'

function row(kind: PendingActionRow['kind'], payload: PendingActionRow['payload'], extra: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: ID, kind, payload: { summary: 's', ...payload }, risk: 'high', status: 'executing', claim_status: 'claimed',
    requested_by: 'user', agent_run_id: null, rule_id: null, telegram_message_id: null, decided_via: 'lume',
    decided_at: null, executed_at: null, result: null, error: null, created_at: '', updated_at: '', ...extra,
  }
}

const JOB_ROW = {
  id: JOB, instantly_campaign_id: 'camp-1', location_barrier: false, company_barrier: true, company_strict: false,
}
const PUSH_PAYLOAD = { job_id: JOB, campaign_id: 'camp-1', location_barrier: false, company_barrier: true, company_strict: false }

const noSideEffects = () => {
  expect(decide).not.toHaveBeenCalled()
  for (const f of Object.values(ins)) expect(f).not.toHaveBeenCalled()
  expect(store.insertQueuedLeads).not.toHaveBeenCalled()
  expect(store.activateRule).not.toHaveBeenCalled()
  expect(store.deleteRule).not.toHaveBeenCalled()
}

beforeEach(() => {
  for (const g of [store, svc, ins, tg]) for (const f of Object.values(g)) f.mockReset()
  decide.mockReset()
  decide.mockResolvedValue({ ok: true, claimed: true, action: 'x', target_id: JOB })
  tg.sendMessage.mockResolvedValue({ ok: true, messageId: 1 })
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  process.env.LUME_ACTION_SECRET = 'action-secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const lastFinish = () => store.finishAction.mock.calls.at(-1)!

describe('executeAction dispatch table', () => {
  it('has a handler for every kind the DB allows', () => {
    expect(EXECUTABLE_KINDS.sort()).toEqual([
      'activate_rule', 'assign_leads', 'create_campaign', 'decide_gate', 'delete_rule', 'launch_campaign',
      'pause_campaign', 'push_to_instantly', 'resume_campaign', 'send_reply',
    ])
  })

  it('push_to_instantly: snapshot matches → push_go', async () => {
    store.claimExecution.mockResolvedValue(row('push_to_instantly', PUSH_PAYLOAD))
    svc.getPushJob.mockResolvedValue(JOB_ROW)
    const out = await executeAction(ID)
    expect(decide).toHaveBeenCalledWith(`push_go:${JOB}`)
    expect(out).toMatchObject({ ran: true, status: 'executed' })
    expect(lastFinish()[1]).toBe('executed')
    expect(tg.sendMessage).toHaveBeenCalledOnce()
  })

  it.each([
    ['campaign_id', { instantly_campaign_id: 'camp-2' }],
    ['location_barrier', { location_barrier: true }],
    ['company_barrier', { company_barrier: false }],
    ['company_strict', { company_strict: true }],
  ])('push_to_instantly: %s changed → failed, no push_go', async (field, patch) => {
    store.claimExecution.mockResolvedValue(row('push_to_instantly', PUSH_PAYLOAD))
    svc.getPushJob.mockResolvedValue({ ...JOB_ROW, ...patch })
    const out = await executeAction(ID)
    expect(decide).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ran: true, status: 'failed' })
    const [, status, result, error] = lastFinish()
    expect(status).toBe('failed')
    expect(error).toContain(field)
    expect(result.error).toContain(field)
    expect(tg.sendMessage.mock.calls[0][0]).toContain('Failed')
  })

  it('push_to_instantly: null DB barriers use the confirmed defaults', async () => {
    store.claimExecution.mockResolvedValue(row('push_to_instantly', PUSH_PAYLOAD))
    svc.getPushJob.mockResolvedValue({ ...JOB_ROW, location_barrier: null, company_barrier: null, company_strict: null })
    await executeAction(ID)
    expect(decide).toHaveBeenCalledWith(`push_go:${JOB}`)
  })

  it('push_go claimed:false (handled elsewhere) → failed', async () => {
    store.claimExecution.mockResolvedValue(row('push_to_instantly', PUSH_PAYLOAD))
    svc.getPushJob.mockResolvedValue(JOB_ROW)
    decide.mockResolvedValue({ ok: true, claimed: false, action: 'push_go', target_id: JOB })
    expect(await executeAction(ID)).toMatchObject({ status: 'failed' })
  })

  it('pipeline timeout → executed with result.timeout (outcome unknown, not failed)', async () => {
    store.claimExecution.mockResolvedValue(row('decide_gate', { callback_data: `approve:${JOB}` }))
    decide.mockResolvedValue({ ok: false, status: 0, error: 'timeout' })
    const out = await executeAction(ID)
    expect(out).toMatchObject({ status: 'executed', result: { timeout: true } })
  })

  it('launch_campaign: camp_launch, then records the Instantly status', async () => {
    store.claimExecution.mockResolvedValue(row('launch_campaign', { job_id: JOB, campaign_id: 'camp-1' }))
    decide.mockResolvedValue({ ok: true, claimed: null, action: 'camp_launch', target_id: JOB })
    ins.getCampaignDetail.mockResolvedValue({ id: 'camp-1', status: 1 })
    const out = await executeAction(ID)
    expect(decide).toHaveBeenCalledWith(`camp_launch:${JOB}`)
    expect(ins.getCampaignDetail).toHaveBeenCalledWith('camp-1')
    expect(out).toMatchObject({ status: 'executed', result: { instantly_status: 1, claimed: null } })
  })

  it('decide_gate: forwards callback_data', async () => {
    store.claimExecution.mockResolvedValue(row('decide_gate', { callback_data: `approve:${JOB}` }))
    await executeAction(ID)
    expect(decide).toHaveBeenCalledWith(`approve:${JOB}`)
  })

  it('assign_leads: queues lowercased rows for the campaign', async () => {
    store.claimExecution.mockResolvedValue(
      row('assign_leads', { campaign_id: 'camp-1', leads: [{ email: 'A@X.com', first_name: 'A' }, { email: 'b@x.com' }, { nope: 1 }] })
    )
    store.insertQueuedLeads.mockResolvedValue(1)
    const out = await executeAction(ID)
    const rows = store.insertQueuedLeads.mock.calls[0][0]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ campaign_id: 'camp-1', email: 'a@x.com', first_name: 'A' })
    expect(out).toMatchObject({ status: 'executed', result: { requested: 2, inserted: 1, skipped: 1 } })
  })

  it('activate_rule: active + next_run_at from the cron', async () => {
    store.claimExecution.mockResolvedValue(row('activate_rule', { rule_id: RULE }))
    store.getRule.mockResolvedValue({ id: RULE, name: 'r', cron: '0 9 * * *', active: false })
    store.activateRule.mockResolvedValue(true)
    const out = await executeAction(ID)
    const [ruleId, next] = store.activateRule.mock.calls[0]
    expect(ruleId).toBe(RULE)
    expect(new Date(next).getUTCHours()).toBe(9)
    expect(Date.parse(next)).toBeGreaterThan(Date.now())
    expect(out).toMatchObject({ status: 'executed' })
  })

  it('activate_rule: bad cron → failed, rule untouched', async () => {
    store.claimExecution.mockResolvedValue(row('activate_rule', { rule_id: RULE }))
    store.getRule.mockResolvedValue({ id: RULE, name: 'r', cron: 'not a cron', active: false })
    expect(await executeAction(ID)).toMatchObject({ status: 'failed' })
    expect(store.activateRule).not.toHaveBeenCalled()
  })

  it('delete_rule: deletes the row', async () => {
    store.claimExecution.mockResolvedValue(row('delete_rule', { rule_id: RULE }))
    store.deleteRule.mockResolvedValue(true)
    expect(await executeAction(ID)).toMatchObject({ status: 'executed' })
    expect(store.deleteRule).toHaveBeenCalledWith(RULE)
  })

  it('send_reply: Instantly reply with eaccount, reply_to_uuid, body', async () => {
    store.claimExecution.mockResolvedValue(row('send_reply', { eaccount: 'me@x.com', reply_to_uuid: 'u-1', body: 'hi' }))
    ins.sendReply.mockResolvedValue({ id: 'e-1' })
    expect(await executeAction(ID)).toMatchObject({ status: 'executed', result: { email_id: 'e-1' } })
    expect(ins.sendReply).toHaveBeenCalledWith({ eaccount: 'me@x.com', reply_to_uuid: 'u-1', subject: 'Re:', body: 'hi' })
  })

  it('pause_campaign / resume_campaign', async () => {
    store.claimExecution.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }))
    await executeAction(ID)
    expect(ins.pauseCampaign).toHaveBeenCalledWith('camp-1')
    store.claimExecution.mockResolvedValue(row('resume_campaign', { campaign_id: 'camp-1' }))
    await executeAction(ID)
    expect(ins.resumeCampaign).toHaveBeenCalledWith('camp-1')
  })

  it('create_campaign: mirrors the source campaign', async () => {
    store.claimExecution.mockResolvedValue(row('create_campaign', { source_campaign_id: 'camp-1', name: 'Copy' }))
    ins.createCampaignFrom.mockResolvedValue({ id: 'camp-9', name: 'Copy' })
    expect(await executeAction(ID)).toMatchObject({ status: 'executed', result: { campaign_id: 'camp-9' } })
    expect(ins.createCampaignFrom).toHaveBeenCalledWith('camp-1', 'Copy')
  })

  it('a thrown adapter error → failed with result.error', async () => {
    store.claimExecution.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }))
    ins.pauseCampaign.mockRejectedValue(new Error('Instantly 500'))
    const out = await executeAction(ID)
    expect(out).toMatchObject({ status: 'failed', error: 'Instantly 500', result: { error: 'Instantly 500' } })
  })
})

describe('executeAction idempotency', () => {
  it('lost claim (already executing/executed) → no-op, nothing called', async () => {
    store.claimExecution.mockResolvedValue(null)
    store.getAction.mockResolvedValue(row('push_to_instantly', PUSH_PAYLOAD, { status: 'executed' }))
    const out = await executeAction(ID)
    expect(out).toEqual({ ran: false, reason: 'not_claimable', status: 'executed' })
    noSideEffects()
    expect(store.finishAction).not.toHaveBeenCalled()
    expect(tg.sendMessage).not.toHaveBeenCalled()
  })

  it('second execute after a first one is a no-op', async () => {
    store.claimExecution
      .mockResolvedValueOnce(row('pause_campaign', { campaign_id: 'camp-1' }))
      .mockResolvedValueOnce(null)
    store.getAction.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'executed' }))
    await executeAction(ID)
    await executeAction(ID)
    expect(ins.pauseCampaign).toHaveBeenCalledOnce()
    expect(store.finishAction).toHaveBeenCalledOnce()
  })
})

describe('sweepStuckActions', () => {
  it('asks only for approved rows decided more than 2 minutes ago and executes each', async () => {
    const now = new Date('2026-10-25T12:00:00Z')
    store.getStaleApprovedIds.mockResolvedValue([ID])
    store.claimExecution.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }))
    const out = await sweepStuckActions(now)
    expect(store.getStaleApprovedIds.mock.calls[0][0].toISOString()).toBe('2026-10-25T11:58:00.000Z')
    expect(store.claimExecution).toHaveBeenCalledWith(ID)
    expect(out).toHaveLength(1)
  })

  it('nothing stale → nothing runs', async () => {
    store.getStaleApprovedIds.mockResolvedValue([])
    expect(await sweepStuckActions()).toEqual([])
    expect(store.claimExecution).not.toHaveBeenCalled()
  })
})

const req = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('POST /api/actions/[id]/decide', () => {
  it('declares maxDuration 300', () => expect(maxDuration).toBe(300))

  it('approve: claims, notes Telegram, executes', async () => {
    store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'approved', telegram_message_id: 42 }))
    store.claimExecution.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }))
    const res = await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'approve' }), params(ID))
    expect(res.status).toBe(200)
    expect(store.claimDecision).toHaveBeenCalledWith(ID, true)
    expect(tg.editMessage).toHaveBeenCalledWith(42, expect.stringContaining('Approved'))
    expect(tg.sendDecisionNote).toHaveBeenCalledWith('lume_ok', ID)
    expect(ins.pauseCampaign).toHaveBeenCalledOnce()
  })

  it('reject: claims, never executes', async () => {
    store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'rejected' }))
    const res = await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'reject' }), params(ID))
    expect(res.status).toBe(200)
    expect(store.claimDecision).toHaveBeenCalledWith(ID, false)
    expect(store.claimExecution).not.toHaveBeenCalled()
    noSideEffects()
  })

  it('second decide (claim lost, e.g. Telegram won) → 409 already_handled, nothing runs', async () => {
    store.claimDecision.mockResolvedValue(null)
    store.getAction.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'approved' }))
    const res = await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'approve' }), params(ID))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'already_handled' })
    expect(store.claimExecution).not.toHaveBeenCalled()
    noSideEffects()
  })

  it('unknown id → 404; bad id / body → 400', async () => {
    store.claimDecision.mockResolvedValue(null)
    store.getAction.mockResolvedValue(null)
    expect((await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'approve' }), params(ID))).status).toBe(404)
    expect((await decidePOST(req('/api/actions/x/decide', { decision: 'approve' }), params('x'))).status).toBe(400)
    expect((await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'go' }), params(ID))).status).toBe(400)
  })

  it('403 for a non-owner session', async () => {
    process.env.LUME_ALLOWED_EMAIL = 'someone-else@example.com'
    const res = await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'approve' }), params(ID))
    expect(res.status).toBe(403)
    expect(store.claimDecision).not.toHaveBeenCalled()
  })
})

describe('POST /api/actions/[id]/execute', () => {
  it('401 without the right X-Lume-Secret, nothing runs', async () => {
    const res = await executePOST(req(`/api/actions/${ID}/execute`, {}, { 'x-lume-secret': 'wrong' }), params(ID))
    expect(res.status).toBe(401)
    expect(store.claimExecution).not.toHaveBeenCalled()
  })

  it('runs once; a repeat is a 200 no-op', async () => {
    store.claimExecution
      .mockResolvedValueOnce(row('pause_campaign', { campaign_id: 'camp-1' }))
      .mockResolvedValueOnce(null)
    store.getAction.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'executed' }))
    const h = { 'x-lume-secret': 'action-secret' }
    const first = await executePOST(req(`/api/actions/${ID}/execute`, {}, h), params(ID))
    const second = await executePOST(req(`/api/actions/${ID}/execute`, {}, h), params(ID))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ noop: true, status: 'executed' })
    expect(ins.pauseCampaign).toHaveBeenCalledOnce()
  })
})

describe('POST /api/actions (create) — new kinds never execute', () => {
  const created = (kind: string, payload: Record<string, unknown>) => ({
    ...row(kind as PendingActionRow['kind'], payload as PendingActionRow['payload']),
    status: 'awaiting' as const,
  })

  it('assign_leads: creates an awaiting row + prompt, runs nothing', async () => {
    svc.insertPendingAction.mockImplementation(async (r: { kind: string; payload: Record<string, unknown> }) => created(r.kind, r.payload))
    tg.sendActionPrompt.mockResolvedValue({ ok: false, skipped: true })
    const res = await createPOST(req('/api/actions', {
      kind: 'assign_leads', payload: { campaign_id: 'camp-1', leads: [{ email: 'A@x.com' }] },
    }))
    expect(res.status).toBe(201)
    const inserted = svc.insertPendingAction.mock.calls[0][0]
    expect(inserted.payload).toMatchObject({ campaign_id: 'camp-1', count: 1, leads: [{ email: 'a@x.com' }] })
    expect(svc.findAwaitingAction).not.toHaveBeenCalled()
    expect(tg.sendActionPrompt).toHaveBeenCalledOnce()
    noSideEffects()
  })

  it('activate_rule: links rule_id and builds the summary from the rule', async () => {
    store.getRule.mockResolvedValue({ id: RULE, name: 'Daily', cron: '0 9 * * *', active: false })
    svc.insertPendingAction.mockImplementation(async (r: { kind: string; payload: Record<string, unknown> }) => created(r.kind, r.payload))
    tg.sendActionPrompt.mockResolvedValue({ ok: false, skipped: true })
    const res = await createPOST(req('/api/actions', { kind: 'activate_rule', payload: { rule_id: RULE } }))
    expect(res.status).toBe(201)
    expect(svc.insertPendingAction.mock.calls[0][0]).toMatchObject({ rule_id: RULE, payload: { rule_id: RULE } })
    noSideEffects()
  })

  it.each(['push_go', 'camp_launch', 'lume_ok'])('decide_gate refuses %s (needs its own confirmation)', async (a) => {
    const res = await createPOST(req('/api/actions', { kind: 'decide_gate', payload: { callback_data: `${a}:${JOB}` } }))
    expect(res.status).toBe(400)
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('unknown kind / bad payload → 400', async () => {
    expect((await createPOST(req('/api/actions', { kind: 'nuke', payload: {} }))).status).toBe(400)
    expect((await createPOST(req('/api/actions', { kind: 'send_reply', payload: { eaccount: 'x' } }))).status).toBe(400)
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })
})
