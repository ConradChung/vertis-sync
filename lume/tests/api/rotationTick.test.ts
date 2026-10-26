import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({
  getDueRules: vi.fn(),
  claimRule: vi.fn(),
  findAwaitingRuleAction: vi.fn(),
  findAwaitingAction: vi.fn(),
  countCandidates: vi.fn(),
  getCampaignByExternalId: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
  setRuleResult: vi.fn(),
  expireStaleActions: vi.fn(),
  logEvent: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({
  ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...a: unknown[]) => svc[k as keyof typeof svc](...a)])),
  isDbError: (e: unknown) => e instanceof Error && 'code' in e,
}))

const tg = vi.hoisted(() => ({ sendActionPrompt: vi.fn(), sendMessage: vi.fn(), editMessage: vi.fn() }))
vi.mock('@/lib/adapters/telegram', () => ({
  sendActionPrompt: (...a: unknown[]) => tg.sendActionPrompt(...a),
  sendMessage: (...a: unknown[]) => tg.sendMessage(...a),
  editMessage: (...a: unknown[]) => tg.editMessage(...a),
}))

const sweep = vi.hoisted(() => vi.fn())
const recover = vi.hoisted(() => vi.fn())
vi.mock('@/lib/actions/execute', () => ({
  sweepStuckActions: (...a: unknown[]) => sweep(...a),
  recoverInterruptedActions: (...a: unknown[]) => recover(...a),
}))

import { POST } from '@/app/api/cron/rotation-tick/route'

const SECRET = 'hook-secret-for-tests'
const RULE = '3f0c8a52-6a55-4c1b-9d7e-2f8a1c0b9e11'
const CAMP = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const ACTION = 'a1b2c3d4-0000-4000-8000-000000000001'
const NOW = new Date('2026-10-16T15:00:30Z') // Fri 08:00:30 PDT

const tick = (secret: string | null = SECRET) =>
  POST(
    new Request('http://localhost/api/cron/rotation-tick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'X-Lume-Hook-Secret': secret } : {}) },
      body: '{}',
    })
  )

const rule = (over: Record<string, unknown> = {}) => ({
  id: RULE,
  name: 'Weekday Austin',
  campaign_id: CAMP,
  filter: { city: 'Austin' },
  daily_cap: 40,
  order_by: 'newest',
  cron: '0 8 * * 1-5',
  next_run_at: '2026-10-16T15:00:00.000Z',
  ...over,
})

const fetchSpy = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.LUME_HOOK_SECRET = SECRET
  for (const f of [...Object.values(svc), ...Object.values(tg)]) f.mockReset()
  svc.getDueRules.mockResolvedValue([rule()])
  svc.claimRule.mockResolvedValue(true)
  svc.findAwaitingRuleAction.mockResolvedValue(null)
  svc.countCandidates.mockResolvedValue(125)
  svc.getCampaignByExternalId.mockResolvedValue({ name: 'Kaspen Rotation', external_id: CAMP })
  svc.insertPendingAction.mockImplementation(async (row: Record<string, unknown>) => ({
    id: ACTION,
    status: 'awaiting',
    telegram_message_id: null,
    ...row,
  }))
  svc.setActionMessageId.mockResolvedValue(undefined)
  svc.setRuleResult.mockResolvedValue(undefined)
  svc.expireStaleActions.mockResolvedValue([])
  svc.logEvent.mockResolvedValue(null)
  tg.sendActionPrompt.mockResolvedValue({ ok: true, messageId: 77 })
  tg.sendMessage.mockResolvedValue({ ok: true, messageId: 78 })
  tg.editMessage.mockResolvedValue({ ok: true, messageId: 77 })
  sweep.mockReset()
  sweep.mockResolvedValue([])
  recover.mockReset()
  recover.mockResolvedValue([])
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/cron/rotation-tick', () => {
  it('401 without the hook secret, touching nothing', async () => {
    expect((await tick(null)).status).toBe(401)
    expect((await tick('wrong')).status).toBe(401)
    expect(svc.getDueRules).not.toHaveBeenCalled()
    expect(svc.expireStaleActions).not.toHaveBeenCalled()
  })

  it('claims the rule by advancing next_run_at (owner TZ) before anything else, then creates one assign_leads action', async () => {
    const res = await tick()
    expect(res.status).toBe(200)
    // next weekday 08:00 Los Angeles after Fri 08:00:30 PDT = Mon 08:00 PDT
    expect(svc.claimRule).toHaveBeenCalledWith(RULE, '2026-10-19T15:00:00.000Z', NOW.toISOString())
    const claimOrder = svc.claimRule.mock.invocationCallOrder[0]
    expect(claimOrder).toBeLessThan(svc.findAwaitingRuleAction.mock.invocationCallOrder[0])
    expect(claimOrder).toBeLessThan(svc.countCandidates.mock.invocationCallOrder[0])

    expect(svc.countCandidates).toHaveBeenCalledWith({ city: 'Austin' }, CAMP)
    expect(svc.insertPendingAction).toHaveBeenCalledTimes(1)
    const row = svc.insertPendingAction.mock.calls[0][0]
    expect(row).toMatchObject({ kind: 'assign_leads', requested_by: 'rule', rule_id: RULE })
    expect(row.payload).toMatchObject({
      campaign_id: CAMP,
      campaign_name: 'Kaspen Rotation',
      filter: { city: 'Austin' },
      count: 40,
      available: 125,
      daily_cap: 40,
      order_by: 'newest',
      rule_id: RULE,
    })
    expect(row.payload.summary).toContain('40')
    expect(row.payload.summary).toContain('Kaspen Rotation')
    // Telegram prompt with lume_ok / lume_no comes from the shared helper
    expect(tg.sendActionPrompt).toHaveBeenCalledTimes(1)
    expect(svc.setRuleResult).toHaveBeenCalledWith(RULE, expect.objectContaining({ action_id: ACTION, count: 40, available: 125 }))
    const body = await res.json()
    expect(body.rules).toEqual([expect.objectContaining({ rule_id: RULE, outcome: 'created', action_id: ACTION })])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('skips when the claim returns nothing (another tick got there first)', async () => {
    svc.claimRule.mockResolvedValue(false)
    const body = await (await tick()).json()
    expect(body.rules).toEqual([expect.objectContaining({ rule_id: RULE, outcome: 'skipped', reason: 'claimed_elsewhere' })])
    expect(svc.countCandidates).not.toHaveBeenCalled()
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
    expect(svc.setRuleResult).not.toHaveBeenCalled()
    expect(tg.sendActionPrompt).not.toHaveBeenCalled()
  })

  it('skips when an awaiting assign_leads action for the rule already exists', async () => {
    svc.findAwaitingRuleAction.mockResolvedValue({ id: 'existing-action' })
    const body = await (await tick()).json()
    expect(svc.claimRule).toHaveBeenCalled()
    expect(svc.findAwaitingRuleAction).toHaveBeenCalledWith('assign_leads', RULE)
    expect(body.rules).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'action_awaiting', action_id: 'existing-action' })])
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
    expect(tg.sendActionPrompt).not.toHaveBeenCalled()
    expect(svc.setRuleResult).toHaveBeenCalledWith(RULE, expect.objectContaining({ skipped: 'action_awaiting', action_id: 'existing-action' }))
  })

  it('maps a 23505 from the unique index to skipped', async () => {
    // tick's check, createAction's pre-check, then the re-read after 23505
    svc.findAwaitingRuleAction.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' })
    svc.insertPendingAction.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    const body = await (await tick()).json()
    expect(svc.insertPendingAction).toHaveBeenCalledTimes(1)
    expect(body.rules).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'action_awaiting', action_id: 'winner' })])
    expect(tg.sendMessage).not.toHaveBeenCalled()
  })

  it('no candidates: records it, no action, no prompt', async () => {
    svc.countCandidates.mockResolvedValue(0)
    const body = await (await tick()).json()
    expect(body.rules).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'no_candidates' })])
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
    expect(svc.setRuleResult).toHaveBeenCalledWith(RULE, expect.objectContaining({ count: 0, skipped: 'no_candidates' }))
  })

  it('on error writes last_result.error and pings Telegram, never creates an action or pushes', async () => {
    svc.countCandidates.mockRejectedValue(new Error('statement timeout'))
    const res = await tick()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rules).toEqual([expect.objectContaining({ rule_id: RULE, outcome: 'error', error: 'statement timeout' })])
    expect(svc.setRuleResult).toHaveBeenCalledWith(RULE, expect.objectContaining({ error: 'statement timeout' }))
    expect(tg.sendMessage).toHaveBeenCalledTimes(1)
    expect(tg.sendMessage.mock.calls[0][0]).toContain('Weekday Austin')
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
    expect(tg.sendActionPrompt).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an unparseable cron is claimed a day out and reported as an error', async () => {
    svc.getDueRules.mockResolvedValue([rule({ cron: 'nonsense' })])
    const body = await (await tick()).json()
    expect(svc.claimRule).toHaveBeenCalledWith(RULE, '2026-10-17T15:00:30.000Z', NOW.toISOString())
    expect(body.rules).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(svc.setRuleResult).toHaveBeenCalledWith(RULE, expect.objectContaining({ error: expect.stringContaining('cron') }))
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('one failing rule does not stop the next', async () => {
    const OTHER = '3f0c8a52-6a55-4c1b-9d7e-2f8a1c0b9e22'
    svc.getDueRules.mockResolvedValue([rule(), rule({ id: OTHER, name: 'Second' })])
    svc.countCandidates.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(5)
    const body = await (await tick()).json()
    expect(body.rules.map((r: { outcome: string }) => r.outcome)).toEqual(['error', 'created'])
    expect(svc.insertPendingAction.mock.calls[0][0].payload.count).toBe(5)
  })

  it('expires awaiting actions older than 24 h, edits their prompts and logs them', async () => {
    svc.getDueRules.mockResolvedValue([])
    svc.expireStaleActions.mockResolvedValue([
      { id: ACTION, kind: 'assign_leads', telegram_message_id: 55, payload: { summary: 'Assign 40 leads' } },
      { id: 'b2', kind: 'push_to_instantly', telegram_message_id: null, payload: {} },
    ])
    const body = await (await tick()).json()
    expect(svc.expireStaleActions).toHaveBeenCalledWith(new Date(NOW.getTime() - 24 * 3600_000).toISOString())
    expect(body.expired).toBe(2)
    expect(tg.editMessage).toHaveBeenCalledTimes(1)
    expect(tg.editMessage.mock.calls[0][0]).toBe(55)
    expect(tg.editMessage.mock.calls[0][1]).toContain('Expired')
    expect(svc.logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'lume.action_expired', source_id: ACTION }))
  })

  it('expiry still runs when the rules query fails, and the failure is a 500', async () => {
    svc.getDueRules.mockRejectedValue(new Error('db down'))
    const res = await tick()
    expect(res.status).toBe(500)
    expect(svc.expireStaleActions).toHaveBeenCalled()
  })

  it('sweeps approved-but-unexecuted actions on every tick, dispatching to the request origin, and reports them', async () => {
    svc.getDueRules.mockResolvedValue([])
    sweep.mockResolvedValue([
      { id: ACTION, outcome: 'dispatched' },
      { id: 'c3', outcome: { error: 'execute returned 401' } },
    ])
    recover.mockResolvedValue(['d4'])
    const res = await tick()
    expect(res.status).toBe(200)
    expect(sweep).toHaveBeenCalledOnce()
    expect((sweep.mock.calls[0][0] as Date).toISOString()).toBe(NOW.toISOString())
    expect(sweep.mock.calls[0][1]).toBe('http://localhost')
    const body = await res.json()
    expect(body.swept).toEqual([
      { id: ACTION, status: 'dispatched' },
      { id: 'c3', status: 'error: execute returned 401' },
    ])
    expect(body.interrupted).toEqual(['d4'])
    expect(recover).toHaveBeenCalledOnce()
  })

  it('LUME_INTERNAL_URL overrides the request origin for the dispatch', async () => {
    vi.stubEnv('LUME_INTERNAL_URL', 'http://127.0.0.1:3000/')
    svc.getDueRules.mockResolvedValue([])
    await tick()
    expect(sweep.mock.calls[0][1]).toBe('http://127.0.0.1:3000')
    vi.unstubAllEnvs()
  })

  it('a failing interrupted recovery is a 500 but the sweep still ran', async () => {
    recover.mockRejectedValue(new Error('db down'))
    const res = await tick()
    expect(res.status).toBe(500)
    expect(sweep).toHaveBeenCalledOnce()
    expect((await res.json()).errors).toEqual([expect.stringContaining('interrupted')])
  })

  it('a failing sweep is a 500 but the rules still ran', async () => {
    sweep.mockRejectedValue(new Error('db down'))
    const res = await tick()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.rules).toEqual([expect.objectContaining({ outcome: 'created' })])
    expect(body.errors).toEqual([expect.stringContaining('sweep')])
  })

  it('the sweeper is not called before the hook secret is checked', async () => {
    await tick('wrong')
    expect(sweep).not.toHaveBeenCalled()
  })
})
