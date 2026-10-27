import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingActionRow } from '@/lib/db/types'

// Every side effect is mocked: no DB, no Telegram, no Instantly, no pipeline.
const store = vi.hoisted(() => ({
  claimExecution: vi.fn(),
  finishAction: vi.fn(),
  getAction: vi.fn(),
  getStaleApprovedIds: vi.fn(),
  failInterruptedActions: vi.fn(),
  insertQueuedLeads: vi.fn(),
  resolveLeadsByRefs: vi.fn(),
  resolveLeadsByFilter: vi.fn(),
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
  findAwaitingRuleAction: vi.fn(),
  getRule: vi.fn(),
  getCampaignByExternalId: vi.fn(),
  resolveLeadRefs: vi.fn(),
  countCandidates: vi.fn(),
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

const ops = vi.hoisted(() => ({ getOperator: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)

vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
import { feed } from '../stubs/feed'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))

import { nextRun as ruleNextRun } from '@/lib/rules/nextRun'
import { EXECUTABLE_KINDS, executeAction, recoverInterruptedActions, sweepStuckActions } from '@/lib/actions/execute'
import { POST as decidePOST, maxDuration } from '@/app/api/actions/[id]/decide/route'
import { POST as executePOST } from '@/app/api/actions/[id]/execute/route'
import { POST as createPOST } from '@/app/api/actions/route'
import { signOperatorCookie } from '@/lib/operators/cookie'

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
  feed.rows = []
  delete process.env.ALERT_CHANNELS
  delete process.env.LUME_URL
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  process.env.LUME_ACTION_SECRET = 'action-secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const lastFinish = () => store.finishAction.mock.calls.at(-1)!

describe('executeAction dispatch table', () => {
  it('has a handler for every kind the DB allows', () => {
    expect(EXECUTABLE_KINDS.sort()).toEqual([
      'activate_rule', 'assign_leads', 'create_campaign', 'crm_close_deal', 'decide_gate', 'delete_rule', 'launch_campaign',
      'pause_campaign', 'push_to_instantly', 'resume_campaign', 'run_actor', 'send_reply',
      'update_sequence',
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

  const LEAD_A = '11111111-1111-4111-8111-111111111111'
  const LEAD_B = '22222222-2222-4222-8222-222222222222'

  it('assign_leads (lead refs, as drag-drop builds them): resolves at execute time and queues them', async () => {
    store.claimExecution.mockResolvedValue(
      row('assign_leads', {
        campaign_id: 'camp-1', campaign_name: 'K', count: 2,
        leads: [{ origin: 'validation_rows', id: LEAD_A }, { origin: 'lead_bank', id: LEAD_B }, { nope: 1 }],
      })
    )
    store.resolveLeadsByRefs.mockResolvedValue([
      { campaign_id: 'camp-1', email: 'a@x.com', first_name: 'A' },
      { campaign_id: 'camp-1', email: 'b@x.com' },
    ])
    store.insertQueuedLeads.mockResolvedValue(1)
    const out = await executeAction(ID)
    expect(store.resolveLeadsByRefs).toHaveBeenCalledWith(
      [{ origin: 'validation_rows', id: LEAD_A }, { origin: 'lead_bank', id: LEAD_B }],
      'camp-1'
    )
    expect(store.resolveLeadsByFilter).not.toHaveBeenCalled()
    expect(store.insertQueuedLeads.mock.calls[0][0]).toHaveLength(2)
    expect(out).toMatchObject({ status: 'executed', result: { mode: 'leads', requested: 2, inserted: 1, skipped: 1 } })
  })

  it('assign_leads (filter, as the rotation tick builds it): resolves up to the confirmed count, rule order', async () => {
    store.claimExecution.mockResolvedValue(
      row('assign_leads', {
        campaign_id: 'camp-1', filter: { city: 'Austin', bogus: 1 }, order_by: 'oldest', count: 40, available: 125,
        daily_cap: 40, rule_id: RULE,
      }, { rule_id: RULE, requested_by: 'rule' })
    )
    store.resolveLeadsByFilter.mockResolvedValue([{ campaign_id: 'camp-1', email: 'a@x.com' }])
    store.insertQueuedLeads.mockResolvedValue(1)
    const out = await executeAction(ID)
    // A stored filter that no longer parses resolves to {} (never widened by unknown keys).
    expect(store.resolveLeadsByFilter).toHaveBeenCalledWith({}, 'camp-1', 40, 'oldest')
    expect(out).toMatchObject({ status: 'executed', result: { mode: 'filter', requested: 1, inserted: 1 } })
  })

  it('assign_leads (filter from a drag): defaults to newest first', async () => {
    store.claimExecution.mockResolvedValue(row('assign_leads', { campaign_id: 'camp-1', filter: { icp_status: 'fit' }, count: 312 }))
    store.resolveLeadsByFilter.mockResolvedValue([])
    const out = await executeAction(ID)
    expect(store.resolveLeadsByFilter).toHaveBeenCalledWith({ icp_status: 'fit' }, 'camp-1', 312, 'newest')
    expect(store.insertQueuedLeads).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'executed', result: { requested: 0, inserted: 0 } })
  })

  it.each([
    ['explicit lead rows (not refs)', { campaign_id: 'camp-1', leads: [{ email: 'a@x.com' }] }],
    ['neither leads nor filter', { campaign_id: 'camp-1' }],
    ['filter without count', { campaign_id: 'camp-1', filter: {} }],
  ])('assign_leads: %s → failed, nothing inserted', async (_l, payload) => {
    store.claimExecution.mockResolvedValue(row('assign_leads', payload))
    expect(await executeAction(ID)).toMatchObject({ status: 'failed' })
    expect(store.insertQueuedLeads).not.toHaveBeenCalled()
  })

  it('activate_rule: active + next_run_at from the cron', async () => {
    store.claimExecution.mockResolvedValue(row('activate_rule', { rule_id: RULE }))
    store.getRule.mockResolvedValue({ id: RULE, name: 'r', cron: '0 9 * * *', active: false })
    store.activateRule.mockResolvedValue(true)
    const out = await executeAction(ID)
    const [ruleId, next] = store.activateRule.mock.calls[0]
    expect(ruleId).toBe(RULE)
    // Owner wall clock (America/Los_Angeles), the same as the rotation tick.
    const laHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date(next))
    expect(Number(laHour)).toBe(9)
    expect(Date.parse(next) - Date.parse(ruleNextRun('0 9 * * *', new Date(Date.parse(next) - 60_000))!)).toBe(0)
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
  const now = new Date('2026-10-25T12:00:00Z')
  const ORIGIN = 'http://127.0.0.1:3000'
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubEnv('LUME_ACTION_SECRET', 'action-secret')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('asks for at most 10 approved rows decided over 2 minutes ago and POSTs each to the execute route; never runs inline', async () => {
    store.getStaleApprovedIds.mockResolvedValue([ID])
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    const out = await sweepStuckActions(now, ORIGIN + '/')
    expect(store.getStaleApprovedIds.mock.calls[0][0].toISOString()).toBe('2026-10-25T11:58:00.000Z')
    expect(store.getStaleApprovedIds.mock.calls[0][1]).toBe(10)
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${ORIGIN}/api/actions/${ID}/execute`)
    expect(init.method).toBe('POST')
    expect(init.headers['X-Lume-Secret']).toBe('action-secret')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(store.claimExecution).not.toHaveBeenCalled()
    expect(out).toEqual([{ id: ID, outcome: 'dispatched' }])
  })

  it('a dispatch that times out counts as dispatched (the execute route keeps running)', async () => {
    store.getStaleApprovedIds.mockResolvedValue([ID])
    fetchSpy.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    expect(await sweepStuckActions(now, ORIGIN)).toEqual([{ id: ID, outcome: 'dispatched' }])
  })

  it('a refused or unreachable dispatch is reported as an error', async () => {
    store.getStaleApprovedIds.mockResolvedValue(['a', 'b'])
    fetchSpy
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await sweepStuckActions(now, ORIGIN)).toEqual([
      { id: 'a', outcome: { error: 'execute returned 401' } },
      { id: 'b', outcome: { error: 'fetch failed' } },
    ])
  })

  it('without LUME_ACTION_SECRET nothing is sent', async () => {
    vi.stubEnv('LUME_ACTION_SECRET', '')
    store.getStaleApprovedIds.mockResolvedValue([ID])
    expect(await sweepStuckActions(now, ORIGIN)).toEqual([{ id: ID, outcome: { error: 'LUME_ACTION_SECRET is not set' } }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('nothing stale → nothing sent', async () => {
    store.getStaleApprovedIds.mockResolvedValue([])
    expect(await sweepStuckActions(now, ORIGIN)).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('recoverInterruptedActions', () => {
  it('fails executing rows untouched for 10 minutes, posts a notice per row, never re-runs them', async () => {
    const now = new Date('2026-10-25T12:00:00Z')
    store.failInterruptedActions.mockResolvedValue([row('pause_campaign', { campaign_id: 'camp-1', summary: 'Pause X' }, { status: 'failed' })])
    expect(await recoverInterruptedActions(now)).toEqual([ID])
    expect(store.failInterruptedActions.mock.calls[0][0].toISOString()).toBe('2026-10-25T11:50:00.000Z')
    expect(tg.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Interrupted — pause_campaign'), expect.anything())
    expect(tg.sendMessage.mock.calls[0][0]).toContain('Pause X')
    expect(store.claimExecution).not.toHaveBeenCalled()
    expect(ins.pauseCampaign).not.toHaveBeenCalled()
  })

  it('nothing interrupted → no notice', async () => {
    store.failInterruptedActions.mockResolvedValue([])
    expect(await recoverInterruptedActions(new Date())).toEqual([])
    expect(tg.sendMessage).not.toHaveBeenCalled()
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
    expect(store.claimDecision).toHaveBeenCalledWith(ID, true, 'lume', undefined)
    expect(tg.editMessage).toHaveBeenCalledWith(42, expect.stringContaining('Approved'))
    expect(tg.sendDecisionNote).toHaveBeenCalledWith('lume_ok', ID)
    expect(ins.pauseCampaign).toHaveBeenCalledOnce()
  })

  it('a Grok Bot operator session is attributed: decided_via operator + decided_by_operator', async () => {
    const OP = '9b2f4c1e-0d3a-4e5b-8c7d-6e5f4a3b2c1d'
    vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
    ops.getOperator.mockResolvedValue({ id: OP, vertical_id: 'v1', is_master: false, label: 'Roofers bot', revoked_at: null })
    store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'rejected', telegram_message_id: 42 }))
    const res = await decidePOST(
      req(`/api/actions/${ID}/decide`, { decision: 'reject' }, { cookie: `lume_op=${signOperatorCookie(OP, 'internal-secret')}` }),
      params(ID)
    )
    vi.unstubAllEnvs()
    expect(res.status).toBe(200)
    expect(store.claimDecision).toHaveBeenCalledWith(ID, false, 'operator', OP)
    expect(tg.editMessage).toHaveBeenCalledWith(42, expect.stringContaining('Roofers bot'))
  })

  it('a revoked operator or a forged cookie decides as the owner (lume)', async () => {
    const OP = '9b2f4c1e-0d3a-4e5b-8c7d-6e5f4a3b2c1d'
    vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
    ops.getOperator.mockResolvedValue({ id: OP, vertical_id: 'v1', is_master: false, label: 'x', revoked_at: '2026-10-26T00:00:00Z' })
    store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'rejected' }))
    await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'reject' }, { cookie: `lume_op=${signOperatorCookie(OP, 'internal-secret')}` }), params(ID))
    await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'reject' }, { cookie: `lume_op=${signOperatorCookie(OP, 'forged')}` }), params(ID))
    vi.unstubAllEnvs()
    expect(store.claimDecision.mock.calls).toEqual([
      [ID, false, 'lume', undefined],
      [ID, false, 'lume', undefined],
    ])
  })

  it('403 session_required for the internal bearer: the agent cannot approve its own action', async () => {
    vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
    const res = await decidePOST(
      req(`/api/actions/${ID}/decide`, { decision: 'approve' }, { authorization: 'Bearer internal-secret' }),
      params(ID)
    )
    vi.unstubAllEnvs()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'session_required' })
    expect(store.claimDecision).not.toHaveBeenCalled()
  })

  it('reject: claims, never executes', async () => {
    store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'rejected' }))
    const res = await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'reject' }), params(ID))
    expect(res.status).toBe(200)
    expect(store.claimDecision).toHaveBeenCalledWith(ID, false, 'lume', undefined)
    expect(store.claimExecution).not.toHaveBeenCalled()
    noSideEffects()
  })

  describe('plain HTML form (the /operator page)', () => {
    const form = (body: string, headers: Record<string, string> = {}) =>
      new Request(`http://localhost/api/actions/${ID}/decide`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...headers },
      })

    it('deny → same claim, 303 back to return_to with a flash, nothing runs', async () => {
      store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'rejected' }))
      const res = await decidePOST(form('decision=reject&return_to=%2Foperator%3Fvertical%3Dv1'), params(ID))
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('http://localhost/operator?vertical=v1&flash=Denied%3A+pause_campaign')
      expect(store.claimDecision).toHaveBeenCalledWith(ID, false, 'lume', undefined)
      noSideEffects()
    })

    it('a Grok Bot form decision is attributed to the operator through its cookie', async () => {
      const OP = '9b2f4c1e-0d3a-4e5b-8c7d-6e5f4a3b2c1d'
      vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
      ops.getOperator.mockResolvedValue({ id: OP, vertical_id: 'v1', is_master: false, label: 'Roofers bot', revoked_at: null })
      store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'rejected' }))
      const res = await decidePOST(form('decision=reject', { cookie: `lume_op=${signOperatorCookie(OP, 'internal-secret')}` }), params(ID))
      vi.unstubAllEnvs()
      expect(res.status).toBe(303)
      expect(store.claimDecision).toHaveBeenCalledWith(ID, false, 'operator', OP)
    })

    it('approve → dispatched to the execute route (own function), 303 at once', async () => {
      store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'approved' }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
      const res = await decidePOST(form('decision=approve'), params(ID))
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toContain('flash=Approved')
      expect(fetchSpy).toHaveBeenCalledWith(`http://localhost/api/actions/${ID}/execute`, expect.objectContaining({ method: 'POST' }))
      fetchSpy.mockRestore()
      expect(store.claimExecution).not.toHaveBeenCalled()
    })

    it('approve without LUME_ACTION_SECRET runs inline', async () => {
      delete process.env.LUME_ACTION_SECRET
      store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'approved' }))
      store.claimExecution.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }))
      const res = await decidePOST(form('decision=approve'), params(ID))
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toContain('flash=Approved+and+ran')
      expect(ins.pauseCampaign).toHaveBeenCalledOnce()
    })

    it('claim lost → 303 with flash_error', async () => {
      store.claimDecision.mockResolvedValue(null)
      store.getAction.mockResolvedValue(row('pause_campaign', {}, { status: 'approved' }))
      const res = await decidePOST(form('decision=approve'), params(ID))
      expect(res.headers.get('location')).toContain('flash_error=already_handled')
    })

    it('a cross-origin form post is refused before any claim', async () => {
      const res = await decidePOST(form('decision=approve', { origin: 'https://evil.test' }), params(ID))
      expect(res.status).toBe(403)
      expect(store.claimDecision).not.toHaveBeenCalled()
    })
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

  it('assign_leads: creates an awaiting row + prompt with lead refs, runs nothing', async () => {
    svc.getCampaignByExternalId.mockResolvedValue({ name: 'K', external_id: 'camp-1' })
    svc.resolveLeadRefs.mockImplementation(async (refs: unknown[]) => refs)
    svc.insertPendingAction.mockImplementation(async (r: { kind: string; payload: Record<string, unknown> }) => created(r.kind, r.payload))
    tg.sendActionPrompt.mockResolvedValue({ ok: false, skipped: true })
    const lead = { origin: 'validation_rows', id: '11111111-1111-4111-8111-111111111111' }
    const res = await createPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: 'camp-1', leads: [lead] } }))
    expect(res.status).toBe(201)
    const inserted = svc.insertPendingAction.mock.calls[0][0]
    expect(inserted.payload).toMatchObject({ campaign_id: 'camp-1', count: 1, leads: [lead] })
    expect(svc.findAwaitingAction).not.toHaveBeenCalled()
    expect(tg.sendActionPrompt).toHaveBeenCalledOnce()
    noSideEffects()
  })

  it('assign_leads: explicit contact rows are not accepted (one payload shape: refs or filter)', async () => {
    const res = await createPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: 'camp-1', leads: [{ email: 'a@x.com' }] } }))
    expect(res.status).toBe(400)
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('activate_rule: links rule_id and builds the summary from the rule', async () => {
    svc.getRule.mockResolvedValue({ id: RULE, name: 'Daily', campaign_id: 'camp-1', cron: '0 9 * * *', active: false, daily_cap: 40, order_by: 'newest' })
    svc.getCampaignByExternalId.mockResolvedValue(null)
    svc.findAwaitingRuleAction.mockResolvedValue(null)
    svc.insertPendingAction.mockImplementation(async (r: { kind: string; payload: Record<string, unknown> }) => created(r.kind, r.payload))
    tg.sendActionPrompt.mockResolvedValue({ ok: false, skipped: true })
    const res = await createPOST(req('/api/actions', { kind: 'activate_rule', payload: { rule_id: RULE } }))
    expect(res.status).toBe(201)
    expect(svc.insertPendingAction.mock.calls[0][0]).toMatchObject({ rule_id: RULE, payload: { rule_id: RULE } })
    noSideEffects()
  })

  it('activate_rule: a concurrent insert (23505) → 409 duplicate with the winner', async () => {
    svc.getRule.mockResolvedValue({ id: RULE, name: 'Daily', campaign_id: 'camp-1', cron: '0 9 * * *', active: false, daily_cap: 40, order_by: 'newest' })
    svc.getCampaignByExternalId.mockResolvedValue(null)
    svc.findAwaitingRuleAction.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' })
    svc.insertPendingAction.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await createPOST(req('/api/actions', { kind: 'activate_rule', payload: { rule_id: RULE } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'duplicate', existing_id: 'winner' })
    expect(tg.sendActionPrompt).not.toHaveBeenCalled()
  })

  it('delete_rule: one awaiting per rule', async () => {
    store.getRule.mockResolvedValue({ id: RULE, name: 'Daily', cron: '0 9 * * *', active: false })
    svc.findAwaitingRuleAction.mockResolvedValue({ id: 'act-1' })
    const res = await createPOST(req('/api/actions', { kind: 'delete_rule', payload: { rule_id: RULE } }))
    expect(res.status).toBe(409)
    expect(svc.findAwaitingRuleAction).toHaveBeenCalledWith('delete_rule', RULE)
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
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

describe('alert feed (G4): every notice lands in lume_alerts; ALERT_CHANNELS gates Telegram', () => {
  const created = (kind: string, payload: Record<string, unknown>) => ({
    ...row(kind as PendingActionRow['kind'], payload as PendingActionRow['payload']),
    status: 'awaiting' as const,
  })

  it('executor outcome: info row linked to the action, routed by its campaign; Telegram text unchanged', async () => {
    store.claimExecution.mockResolvedValue(row('push_to_instantly', PUSH_PAYLOAD))
    svc.getPushJob.mockResolvedValue(JOB_ROW)
    await executeAction(ID)
    expect(feed.rows).toHaveLength(1)
    expect(feed.rows[0]).toMatchObject({
      source: 'lume.actions', severity: 'info', title: '✅ Done — push_to_instantly', link: `/actions/${ID}`,
      campaign_id: 'camp-1', dedupe_key: null,
    })
    expect(feed.rows[0].body).toBe(tg.sendMessage.mock.calls[0][0])
    expect(tg.sendMessage.mock.calls[0][1]).toEqual({ disablePreview: true })
  })

  it('executor failure → warn; absolute link when LUME_URL is set', async () => {
    process.env.LUME_URL = 'https://lume.example'
    store.claimExecution.mockResolvedValue(row('push_to_instantly', PUSH_PAYLOAD))
    svc.getPushJob.mockResolvedValue({ ...JOB_ROW, instantly_campaign_id: 'camp-2' })
    await executeAction(ID)
    expect(feed.rows[0]).toMatchObject({ severity: 'warn', link: `https://lume.example/actions/${ID}` })
  })

  it('ALERT_CHANNELS=feed: the outcome is in the feed and Telegram is not called', async () => {
    process.env.ALERT_CHANNELS = 'feed'
    store.claimExecution.mockResolvedValue(row('push_to_instantly', PUSH_PAYLOAD))
    svc.getPushJob.mockResolvedValue(JOB_ROW)
    const out = await executeAction(ID)
    expect(out).toMatchObject({ ran: true, status: 'executed' })
    expect(tg.sendMessage).not.toHaveBeenCalled()
    expect(feed.rows).toHaveLength(1)
  })

  it('interrupted notice → warn row', async () => {
    store.failInterruptedActions.mockResolvedValue([row('pause_campaign', { campaign_id: 'camp-1', summary: 'Pause X' }, { status: 'failed' })])
    await recoverInterruptedActions(new Date())
    expect(feed.rows[0]).toMatchObject({ severity: 'warn', title: '⚠️ Interrupted — pause_campaign', campaign_id: 'camp-1', scope: 'campaign' })
  })

  it('decide: one info row; Telegram edit + note exactly as before', async () => {
    store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'rejected', telegram_message_id: 42 }))
    await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'reject' }), params(ID))
    expect(tg.editMessage).toHaveBeenCalledWith(42, '❌ Rejected — pause_campaign (from Lume)')
    expect(tg.sendDecisionNote).toHaveBeenCalledWith('lume_no', ID)
    expect(feed.rows).toEqual([expect.objectContaining({ source: 'lume.actions', severity: 'info', title: '❌ Rejected — pause_campaign (from Lume)', link: `/actions/${ID}` })])
  })

  it('decide with ALERT_CHANNELS=feed: no Telegram edit or note, feed row still written', async () => {
    process.env.ALERT_CHANNELS = 'feed'
    store.claimDecision.mockResolvedValue(row('pause_campaign', { campaign_id: 'camp-1' }, { status: 'rejected', telegram_message_id: 42 }))
    const res = await decidePOST(req(`/api/actions/${ID}/decide`, { decision: 'reject' }), params(ID))
    expect(res.status).toBe(200)
    expect(tg.editMessage).not.toHaveBeenCalled()
    expect(tg.sendDecisionNote).not.toHaveBeenCalled()
    expect(feed.rows).toHaveLength(1)
  })

  it('createAction approval ping: urgent row deduped per action; the Telegram prompt and its message id as before', async () => {
    svc.getCampaignByExternalId.mockResolvedValue({ name: 'K', external_id: 'camp-1' })
    svc.resolveLeadRefs.mockImplementation(async (refs: unknown[]) => refs)
    svc.insertPendingAction.mockImplementation(async (r: { kind: string; payload: Record<string, unknown> }) => created(r.kind, r.payload))
    tg.sendActionPrompt.mockResolvedValue({ ok: true, messageId: 555 })
    const lead = { origin: 'validation_rows', id: '11111111-1111-4111-8111-111111111111' }
    const res = await createPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: 'camp-1', leads: [lead] } }))
    expect(res.status).toBe(201)
    expect(tg.sendActionPrompt).toHaveBeenCalledOnce()
    expect(svc.setActionMessageId).toHaveBeenCalledWith(ID, 555)
    expect(feed.rows).toHaveLength(1)
    expect(feed.rows[0]).toMatchObject({
      source: 'lume.actions', severity: 'urgent', title: '🛡 assign_leads', link: `/actions/${ID}`,
      campaign_id: 'camp-1', scope: 'campaign', dedupe_key: `${ID}:lume_action`,
    })
    expect(feed.rows[0].body).toContain('🛡 assign_leads')
  })

  it('createAction with ALERT_CHANNELS=feed: no Telegram prompt, no message id, still 201 + feed row', async () => {
    process.env.ALERT_CHANNELS = 'feed'
    svc.getCampaignByExternalId.mockResolvedValue({ name: 'K', external_id: 'camp-1' })
    svc.resolveLeadRefs.mockImplementation(async (refs: unknown[]) => refs)
    svc.insertPendingAction.mockImplementation(async (r: { kind: string; payload: Record<string, unknown> }) => created(r.kind, r.payload))
    const lead = { origin: 'validation_rows', id: '11111111-1111-4111-8111-111111111111' }
    const res = await createPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: 'camp-1', leads: [lead] } }))
    expect(res.status).toBe(201)
    expect(tg.sendActionPrompt).not.toHaveBeenCalled()
    expect(svc.setActionMessageId).not.toHaveBeenCalled()
    expect(feed.rows).toHaveLength(1)
  })
})
