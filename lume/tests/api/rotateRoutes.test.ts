import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))

const svc = vi.hoisted(() => ({
  getRules: vi.fn(),
  getRule: vi.fn(),
  insertRule: vi.fn(),
  updateRule: vi.fn(),
  deleteInactiveRule: vi.fn(),
  getAwaitingRuleActions: vi.fn(),
  findAwaitingRuleAction: vi.fn(),
  findAwaitingAction: vi.fn(),
  getCampaigns: vi.fn(),
  getCampaignByExternalId: vi.fn(),
  getQueuedCounts: vi.fn(),
  countCandidates: vi.fn(),
  resolveLeadRefs: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
  syncInstantlyCampaigns: vi.fn(),
  logEvent: vi.fn(),
  getPushJob: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...a: unknown[]) => svc[k as keyof typeof svc](...a)])),
  PUSH_REVIEW_STATUSES: ['configuring', 'reviewing_company'],
  isDbError: (e: unknown) => e instanceof Error && 'code' in e,
}))

const sendActionPrompt = vi.fn()
vi.mock('@/lib/adapters/telegram', () => ({ sendActionPrompt: (...a: unknown[]) => sendActionPrompt(...a) }))
vi.mock('@/lib/adapters/instantlyPush', () => ({ getPushPreview: vi.fn() }))

const listCampaignDetails = vi.fn()
let instantlyConfigured = true
vi.mock('@/lib/adapters/instantly', () => ({
  isInstantlyConfigured: () => instantlyConfigured,
  listCampaignDetails: () => listCampaignDetails(),
  getCampaignSequence: vi.fn(),
  InstantlyError: class extends Error {},
}))

import { GET as rulesGET, POST as rulesPOST } from '@/app/api/rules/route'
import { DELETE as ruleDELETE, PATCH as rulePATCH } from '@/app/api/rules/[id]/route'
import { POST as actionsPOST } from '@/app/api/actions/route'
import { POST as syncPOST } from '@/app/api/campaigns/sync/route'
import { GET as campaignsGET } from '@/app/api/campaigns/route'

const RULE = '3f0c8a52-6a55-4c1b-9d7e-2f8a1c0b9e11'
const CAMP = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const req = (url: string, body?: unknown, method = 'POST') =>
  new Request(`http://localhost${url}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const rule = (over: Record<string, unknown> = {}) => ({
  id: RULE,
  name: 'Weekday',
  campaign_id: CAMP,
  filter: {},
  daily_cap: 40,
  order_by: 'newest',
  cron: '0 8 * * 1-5',
  active: false,
  next_run_at: null,
  last_run_at: null,
  last_result: null,
  created_at: '2026-10-20T00:00:00Z',
  ...over,
})

beforeEach(() => {
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  delete process.env.ROTATE_CAMPAIGN_ID
  for (const f of Object.values(svc)) f.mockReset()
  sendActionPrompt.mockReset()
  sendActionPrompt.mockResolvedValue({ ok: false, skipped: true })
  listCampaignDetails.mockReset()
  instantlyConfigured = true
  svc.logEvent.mockResolvedValue(null)
  svc.findAwaitingRuleAction.mockResolvedValue(null)
  svc.getCampaignByExternalId.mockResolvedValue({ name: 'Kaspen Rotation', external_id: CAMP })
  svc.insertPendingAction.mockImplementation(async (row: Record<string, unknown>) => ({ id: 'act-1', telegram_message_id: null, ...row }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/rules', () => {
  const valid = { name: 'Weekday', campaign_id: CAMP, cron: '0 8 * * 1-5', filter: { city: 'Austin' } }

  it('creates the rule inactive', async () => {
    svc.insertRule.mockResolvedValue(rule())
    const res = await rulesPOST(req('/api/rules', valid))
    expect(res.status).toBe(201)
    expect(svc.insertRule).toHaveBeenCalledWith({
      name: 'Weekday',
      campaign_id: CAMP,
      filter: { city: 'Austin' },
      daily_cap: 40,
      order_by: 'newest',
      cron: '0 8 * * 1-5',
      kind: 'rotate',
      params: {},
    })
  })

  it('creates an inactive cycle_out rule: after_days defaults to 14, cap to 1000 per run', async () => {
    svc.insertRule.mockResolvedValue(rule({ kind: 'cycle_out' }))
    const res = await rulesPOST(req('/api/rules', { name: 'Cycle', campaign_id: CAMP, cron: '0 7 * * *', kind: 'cycle_out', params: { refill_to: 900 } }))
    expect(res.status).toBe(201)
    expect(svc.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cycle_out', params: { after_days: 14, refill_to: 900 }, daily_cap: 1000, filter: {} })
    )
  })

  it.each([
    ['cycle_out with a bad after_days', { kind: 'cycle_out', params: { after_days: 0 } }],
    ['cycle_out with an unknown param', { kind: 'cycle_out', params: { after_days: 14, x: 1 } }],
    ['a rotate rule with params', { params: { after_days: 14 } }],
    ['an unknown kind', { kind: 'purge' }],
    ['cycle_out removing more than 1000 per run', { kind: 'cycle_out', params: { after_days: 14 }, daily_cap: 1001 }],
    ['a rotate rule assigning more than 1000 per run', { daily_cap: 1001 }],
  ])('400 for %s', async (_, patch) => {
    expect((await rulesPOST(req('/api/rules', { ...valid, ...patch }))).status).toBe(400)
    expect(svc.insertRule).not.toHaveBeenCalled()
  })

  it('refuses active=true: activation is a pending action', async () => {
    const res = await rulesPOST(req('/api/rules', { ...valid, active: true }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'activate_via_action' })
    expect(svc.insertRule).not.toHaveBeenCalled()
  })

  it.each([
    ['a cron that fires every 5 minutes', { cron: '*/5 * * * *' }],
    ['garbage cron', { cron: 'soon' }],
    ['a campaign id with PostgREST metacharacters', { campaign_id: 'a,b.c' }],
    ['an unknown filter key', { filter: { foo: 'x' } }],
    ['a zero cap', { daily_cap: 0 }],
  ])('400 for %s', async (_, patch) => {
    expect((await rulesPOST(req('/api/rules', { ...valid, ...patch }))).status).toBe(400)
    expect(svc.insertRule).not.toHaveBeenCalled()
  })
})

describe('GET /api/rules', () => {
  it('joins campaign names and awaiting actions', async () => {
    svc.getRules.mockResolvedValue([rule()])
    svc.getAwaitingRuleActions.mockResolvedValue([{ id: 'act-9', kind: 'activate_rule', rule_id: RULE, created_at: 'x' }])
    svc.getCampaigns.mockResolvedValue([{ external_id: CAMP, name: 'Kaspen Rotation' }])
    const body = await (await rulesGET(req('/api/rules', undefined, 'GET'))).json()
    expect(body[0]).toMatchObject({ id: RULE, campaign_name: 'Kaspen Rotation', awaiting: [{ id: 'act-9', kind: 'activate_rule' }] })
  })
})

describe('PATCH /api/rules/[id]', () => {
  it('refuses active=true', async () => {
    const res = await rulePATCH(req(`/api/rules/${RULE}`, { active: true }, 'PATCH'), ctx(RULE))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'activate_via_action' })
    expect(svc.updateRule).not.toHaveBeenCalled()
  })

  it('pauses with active=false even while an activation is awaiting', async () => {
    svc.getRule.mockResolvedValue(rule({ active: true }))
    svc.findAwaitingRuleAction.mockResolvedValue({ id: 'act-2' })
    svc.updateRule.mockResolvedValue(rule({ active: false }))
    const res = await rulePATCH(req(`/api/rules/${RULE}`, { active: false }, 'PATCH'), ctx(RULE))
    expect(res.status).toBe(200)
    expect(svc.updateRule).toHaveBeenCalledWith(RULE, { active: false })
  })

  it('409 on edits while an activate_rule confirmation is open', async () => {
    svc.getRule.mockResolvedValue(rule())
    svc.findAwaitingRuleAction.mockResolvedValue({ id: 'act-2' })
    const res = await rulePATCH(req(`/api/rules/${RULE}`, { daily_cap: 80 }, 'PATCH'), ctx(RULE))
    expect(res.status).toBe(409)
    expect(svc.updateRule).not.toHaveBeenCalled()
  })

  it('recomputes next_run_at when an active rule changes cron', async () => {
    svc.getRule.mockResolvedValue(rule({ active: true }))
    svc.updateRule.mockResolvedValue(rule({ active: true, cron: '0 9 * * *' }))
    await rulePATCH(req(`/api/rules/${RULE}`, { cron: '0 9 * * *' }, 'PATCH'), ctx(RULE))
    expect(svc.updateRule.mock.calls[0][1]).toMatchObject({ cron: '0 9 * * *', next_run_at: expect.any(String) })
  })

  it('400 for a bad id', async () => {
    expect((await rulePATCH(req('/api/rules/x', { name: 'a' }, 'PATCH'), ctx('x'))).status).toBe(400)
  })
})

describe('DELETE /api/rules/[id]', () => {
  it('409 for an active rule', async () => {
    svc.getRule.mockResolvedValue(rule({ active: true }))
    expect((await ruleDELETE(req(`/api/rules/${RULE}`, undefined, 'DELETE'), ctx(RULE))).status).toBe(409)
    expect(svc.deleteInactiveRule).not.toHaveBeenCalled()
  })

  it('409 while an action for the rule is awaiting', async () => {
    svc.getRule.mockResolvedValue(rule())
    svc.findAwaitingRuleAction.mockImplementation(async (kind: string) => (kind === 'assign_leads' ? { id: 'a' } : null))
    expect((await ruleDELETE(req(`/api/rules/${RULE}`, undefined, 'DELETE'), ctx(RULE))).status).toBe(409)
  })

  it('deletes an inactive rule', async () => {
    svc.getRule.mockResolvedValue(rule())
    svc.deleteInactiveRule.mockResolvedValue(true)
    expect((await ruleDELETE(req(`/api/rules/${RULE}`, undefined, 'DELETE'), ctx(RULE))).status).toBe(200)
  })
})

describe('POST /api/actions — Rotate kinds', () => {
  it('assign_leads with explicit leads: re-resolves them and creates the action + Telegram prompt', async () => {
    const leads = [
      { origin: 'validation_rows', id: '11111111-1111-4111-8111-111111111111' },
      { origin: 'validation_rows', id: '22222222-2222-4222-8222-222222222222' },
    ]
    svc.resolveLeadRefs.mockResolvedValue([leads[0]])
    const res = await actionsPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: CAMP, leads } }))
    expect(res.status).toBe(201)
    const row = svc.insertPendingAction.mock.calls[0][0]
    expect(row).toMatchObject({ kind: 'assign_leads', requested_by: 'user', rule_id: null })
    expect(row.payload).toMatchObject({ campaign_id: CAMP, campaign_name: 'Kaspen Rotation', leads: [leads[0]], count: 1 })
    expect(row.payload.summary).toContain('1 skipped')
    expect(sendActionPrompt).toHaveBeenCalledTimes(1)
  })

  it('assign_leads with a filter snapshots the count', async () => {
    svc.countCandidates.mockResolvedValue(312)
    const res = await actionsPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: CAMP, filter: { icp_status: 'fit' } } }))
    expect(res.status).toBe(201)
    expect(svc.countCandidates).toHaveBeenCalledWith({ icp_status: 'fit' }, CAMP)
    expect(svc.insertPendingAction.mock.calls[0][0].payload).toMatchObject({ filter: { icp_status: 'fit' }, count: 312 })
  })

  it('assign_leads with a filter and limit caps count at the matching total (the agent path)', async () => {
    svc.countCandidates.mockResolvedValue(312)
    const res = await actionsPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: CAMP, filter: {}, limit: 50 } }))
    expect(res.status).toBe(201)
    const payload = svc.insertPendingAction.mock.calls[0][0].payload
    expect(payload).toMatchObject({ campaign_id: CAMP, filter: {}, count: 50 })
    expect(payload).not.toHaveProperty('limit')
    expect(payload.summary).toMatch(/^Assign 50 of 312 matching leads → /)
    svc.insertPendingAction.mockClear()
    await actionsPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: CAMP, filter: {}, limit: 1000 } }))
    expect(svc.insertPendingAction.mock.calls[0][0].payload.count).toBe(312)
  })

  it('assign_leads: 409 when nothing is left to assign, 404 for an unknown campaign', async () => {
    svc.countCandidates.mockResolvedValue(0)
    expect((await actionsPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: CAMP, filter: {} } }))).status).toBe(409)
    svc.getCampaignByExternalId.mockResolvedValue(null)
    expect((await actionsPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: CAMP, filter: {} } }))).status).toBe(404)
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('assign_leads: 400 with both leads and filter, or more than 500 leads', async () => {
    const lead = { origin: 'validation_rows', id: 'x1' }
    expect((await actionsPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: CAMP, leads: [lead], filter: {} } }))).status).toBe(400)
    const many = Array.from({ length: 501 }, (_, i) => ({ origin: 'validation_rows', id: `id${i}` }))
    expect((await actionsPOST(req('/api/actions', { kind: 'assign_leads', payload: { campaign_id: CAMP, leads: many } }))).status).toBe(400)
  })

  it('activate_rule creates a rule-scoped action; a second one is a 409 duplicate', async () => {
    svc.getRule.mockResolvedValue(rule())
    const res = await actionsPOST(req('/api/actions', { kind: 'activate_rule', payload: { rule_id: RULE } }))
    expect(res.status).toBe(201)
    const row = svc.insertPendingAction.mock.calls[0][0]
    expect(row).toMatchObject({ kind: 'activate_rule', rule_id: RULE })
    expect(row.payload).toMatchObject({ rule_id: RULE, cron: '0 8 * * 1-5', tz: 'America/Los_Angeles', first_run: expect.any(String) })

    svc.findAwaitingRuleAction.mockResolvedValue({ id: 'act-1' })
    const dup = await actionsPOST(req('/api/actions', { kind: 'activate_rule', payload: { rule_id: RULE } }))
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'duplicate', existing_id: 'act-1' })
  })

  it('activate_rule on a cycle_out rule describes the removal + refill it will ask for', async () => {
    svc.getRule.mockResolvedValue(rule({ kind: 'cycle_out', params: { after_days: 21, refill_to: 900 }, daily_cap: 1000, cron: '0 7 * * *' }))
    const res = await actionsPOST(req('/api/actions', { kind: 'activate_rule', payload: { rule_id: RULE } }))
    expect(res.status).toBe(201)
    const row = svc.insertPendingAction.mock.calls[0][0]
    expect(row.payload).toMatchObject({ rule_kind: 'cycle_out', params: { after_days: 21, refill_to: 900 } })
    expect(row.payload.summary).toContain('Activate cycle-out rule "Weekday" on Kaspen Rotation')
    expect(row.payload.summary).toContain('finished 21+ days ago with no reply, then refill to 900 leads')
    expect(row.payload.summary).toContain('never removed')
  })

  it('activate_rule: 409 when already active', async () => {
    svc.getRule.mockResolvedValue(rule({ active: true }))
    expect((await actionsPOST(req('/api/actions', { kind: 'activate_rule', payload: { rule_id: RULE } }))).status).toBe(409)
  })
})

describe('POST /api/campaigns/sync', () => {
  it('reads Instantly and upserts lume_campaigns', async () => {
    listCampaignDetails.mockResolvedValue([{ id: CAMP, name: 'K', status: 1, statusLabel: 'active', dailyLimit: 50, accounts: 3 }])
    svc.syncInstantlyCampaigns.mockResolvedValue({ inserted: 1, updated: 0 })
    const res = await syncPOST(req('/api/campaigns/sync', {}))
    expect(await res.json()).toMatchObject({ ok: true, inserted: 1, updated: 0, total: 1 })
    expect(svc.syncInstantlyCampaigns).toHaveBeenCalledWith(expect.any(Array), expect.any(String))
  })

  it('answers configured:false without a key', async () => {
    instantlyConfigured = false
    expect(await (await syncPOST(req('/api/campaigns/sync', {}))).json()).toEqual({ configured: false })
    expect(listCampaignDetails).not.toHaveBeenCalled()
  })
})

describe('GET /api/campaigns', () => {
  it('adds queue depth and marks the rotator campaign', async () => {
    svc.getCampaigns.mockResolvedValue([
      { id: '1', external_id: CAMP, name: 'Rot' },
      { id: '2', external_id: 'other', name: 'Other' },
      { id: '3', external_id: null, name: 'Gmail' },
    ])
    svc.getQueuedCounts.mockResolvedValue({ [CAMP]: 12 })
    const body = await (await campaignsGET(req('/api/campaigns', undefined, 'GET'))).json()
    expect(body.map((c: { queued: number; rotator: boolean }) => [c.queued, c.rotator])).toEqual([
      [12, true],
      [0, false],
      [0, false],
    ])
  })
})
