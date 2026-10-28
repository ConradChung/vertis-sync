import { beforeEach, describe, expect, it, vi } from 'vitest'

const il = vi.hoisted(() => ({ getLeadsByIds: vi.fn(), listCampaignLeads: vi.fn(), getCampaignLeadCount: vi.fn(), MAX_SCAN_PAGES: 50 }))
vi.mock('@/lib/adapters/instantlyLeads', () => il)
const iw = vi.hoisted(() => ({ deleteLeads: vi.fn() }))
vi.mock('@/lib/adapters/instantlyWrite', () => iw)
const ia = vi.hoisted(() => ({ isInstantlyConfigured: vi.fn(() => true) }))
vi.mock('@/lib/adapters/instantly', () => ({
  ...ia,
  InstantlyError: class InstantlyError extends Error {
    status: number
    constructor(s: number, m: string) {
      super(m)
      this.status = s
    }
  },
}))
const svc = vi.hoisted(() => ({ countCandidates: vi.fn(), getCampaignByExternalId: vi.fn(), getRule: vi.fn() }))
vi.mock('@/lib/db/service', () => svc)
const cs = vi.hoisted(() => ({ insertCycledLeads: vi.fn(), archiveLeadBankRows: vi.fn(), countQueuedForCampaign: vi.fn() }))
vi.mock('@/lib/leads/cycledStore', () => cs)
const cr = vi.hoisted(() => {
  class DuplicateActionError extends Error {
    existingId: string
    constructor(id: string) {
      super('dup')
      this.existingId = id
    }
  }
  return { createAction: vi.fn(), DuplicateActionError }
})
vi.mock('@/lib/actions/create', () => cr)

import { buildRemoveLeads, executeRemoveLeads, RemovalFailure } from '@/lib/actions/removeLeads'
import { removeLeadsPayloadError } from '@/lib/actions/removeLeadsPayload'
import type { CampaignLead } from '@/lib/adapters/instantlyLeads.map'

const CID = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const RULE = '11111111-2222-4333-8444-555555555555'
const lead = (id: string, over: Partial<CampaignLead> = {}): CampaignLead => ({
  id,
  email: `${id}@x.com`,
  name: null,
  company: null,
  status: 3,
  status_label: 'completed',
  last_contact_at: '2026-10-01T00:00:00Z',
  last_reply_at: null,
  reply_count: 0,
  interest: null,
  interest_label: null,
  ...over,
})
const fetched = (l: CampaignLead) => ({ lead: l, raw: { id: l.id, email: l.email, status: l.status } })
const campaignName = vi.fn(async () => 'Kaspen PM')

beforeEach(() => {
  for (const m of [il, iw, svc, cs, cr]) for (const f of Object.values(m)) if (typeof f === 'function' && 'mockReset' in f) (f as ReturnType<typeof vi.fn>).mockReset()
  ia.isInstantlyConfigured.mockReturnValue(true)
  cs.insertCycledLeads.mockResolvedValue(undefined)
  cs.archiveLeadBankRows.mockResolvedValue(0)
})

describe('buildRemoveLeads', () => {
  it('by ids: freezes the removable ids, keeps replied/interested out, counts missing', async () => {
    il.getLeadsByIds.mockResolvedValue([fetched(lead('a')), fetched(lead('b', { reply_count: 1 })), fetched(lead('c', { interest: 1 }))])
    const b = await buildRemoveLeads({ campaign_id: CID, reason: 'free cap', lead_ids: ['a', 'b', 'c', 'gone'] }, { campaignName })
    expect(b).toMatchObject({
      ok: true,
      payload: { campaign_id: CID, campaign_name: 'Kaspen PM', lead_ids: ['a'], count: 1, kept_replied: 1, kept_interested: 1, not_found: 1, reason: 'free cap' },
    })
    if (b.ok) expect(b.payload.summary).toMatch(/^Remove 1 lead from Kaspen PM: free cap\. 2 replied\/interested leads kept\./)
  })

  it('by filter: lists the state with the age bound, caps at max', async () => {
    il.listCampaignLeads.mockResolvedValue({ leads: [lead('a'), lead('b'), lead('c')], matched: 3, truncated: false })
    const b = await buildRemoveLeads(
      { campaign_id: CID, reason: 'cycle', filter: { state: 'finished_no_reply', older_than_days: 14 } },
      { campaignName, max: 2 }
    )
    expect(il.listCampaignLeads).toHaveBeenCalledWith(CID, { state: 'finished_no_reply', days: 14 }, expect.objectContaining({ limit: 1000 }))
    expect(b).toMatchObject({ ok: true, payload: { lead_ids: ['a', 'b'], count: 2, filter: { state: 'finished_no_reply', older_than_days: 14 } } })
    if (b.ok) expect(b.payload.summary).toContain('More match')
  })

  it('409 when nothing is removable; 503 when Instantly is not configured; 502 when it fails', async () => {
    il.getLeadsByIds.mockResolvedValue([fetched(lead('b', { reply_count: 2 }))])
    expect(await buildRemoveLeads({ campaign_id: CID, reason: 'x', lead_ids: ['b'] }, { campaignName })).toEqual({ ok: false, status: 409, error: 'nothing_to_remove' })
    il.getLeadsByIds.mockRejectedValue(new Error('boom'))
    expect(await buildRemoveLeads({ campaign_id: CID, reason: 'x', lead_ids: ['b'] }, { campaignName })).toMatchObject({ ok: false, status: 502 })
    ia.isInstantlyConfigured.mockReturnValue(false)
    expect(await buildRemoveLeads({ campaign_id: CID, reason: 'x', lead_ids: ['b'] }, { campaignName })).toMatchObject({ ok: false, status: 503 })
  })
})

describe('removeLeadsPayloadError', () => {
  it('needs a campaign, 1-1000 lead ids and a count', () => {
    expect(removeLeadsPayloadError({ campaign_id: CID, lead_ids: ['a'], count: 1, summary: 's' })).toBeNull()
    expect(removeLeadsPayloadError({ campaign_id: CID, lead_ids: [], count: 0 })).toMatch(/lead_ids/)
    expect(removeLeadsPayloadError({ lead_ids: ['a'], count: 1 })).toMatch(/campaign_id/)
    expect(removeLeadsPayloadError({ campaign_id: CID, lead_ids: ['a b'], count: 1 })).toMatch(/lead ids/)
  })
})

describe('executeRemoveLeads', () => {
  const action = { id: 'act-1', rule_id: null }
  const p = { campaign_id: CID, lead_ids: ['a', 'b', 'c', 'd'], count: 4, reason: 'cap', summary: 's' }

  it('re-reads, always skips replied/interested/missing, snapshots then deletes the rest', async () => {
    il.getLeadsByIds.mockResolvedValue([fetched(lead('a')), fetched(lead('b', { last_reply_at: '2026-10-26T00:00:00Z' })), fetched(lead('c', { interest: 2 }))])
    iw.deleteLeads.mockResolvedValue(1)
    cs.archiveLeadBankRows.mockResolvedValue(1)
    const r = await executeRemoveLeads(p, action, new Date('2026-10-27T00:00:00Z'))
    expect(cs.insertCycledLeads).toHaveBeenCalledWith([
      { campaign_id: CID, instantly_lead_id: 'a', email: 'a@x.com', snapshot: { id: 'a', email: 'a@x.com', status: 3 }, reason: 'cap', action_id: 'act-1' },
    ])
    expect(iw.deleteLeads).toHaveBeenCalledWith(CID, ['a'])
    expect(cs.insertCycledLeads.mock.invocationCallOrder[0]).toBeLessThan(iw.deleteLeads.mock.invocationCallOrder[0])
    expect(cs.archiveLeadBankRows).toHaveBeenCalledWith(CID, [{ email: 'a@x.com', status: 3 }], '2026-10-27T00:00:00.000Z')
    expect(r).toMatchObject({
      campaign_id: CID,
      requested: 4,
      removed: 1,
      instantly_deleted: 1,
      skipped: { replied: 1, interested: 1, not_found: 1 },
      lead_bank_archived: 1,
    })
    expect(r.skipped_leads).toEqual([
      { id: 'b', email: 'b@x.com', why: 'replied' },
      { id: 'c', email: 'c@x.com', why: 'interested' },
      { id: 'd', email: null, why: 'not_found' },
    ])
    expect(r.refill).toBeUndefined()
  })

  it('finished_no_reply / rule removals skip leads no longer completed (bounced or back in sequence)', async () => {
    il.getLeadsByIds.mockResolvedValue([
      fetched(lead('a')),
      fetched(lead('b', { status: -1, status_label: 'bounced' })),
      fetched(lead('c', { status: 1, status_label: 'active' })),
    ])
    iw.deleteLeads.mockResolvedValue(1)
    const fp = { ...p, lead_ids: ['a', 'b', 'c'], filter: { state: 'finished_no_reply', older_than_days: 14 } }
    const r = await executeRemoveLeads(fp, action)
    expect(iw.deleteLeads).toHaveBeenCalledWith(CID, ['a'])
    expect(r).toMatchObject({ removed: 1, skipped: { bounced: 1, no_longer_finished: 1 } })
    expect(r.skipped_leads).toEqual([
      { id: 'b', email: 'b@x.com', why: 'bounced' },
      { id: 'c', email: 'c@x.com', why: 'no_longer_finished' },
    ])

    // A rule-filed removal gets the same check even without a filter in the payload.
    iw.deleteLeads.mockClear()
    svc.getRule.mockResolvedValue(null)
    const r2 = await executeRemoveLeads({ ...p, lead_ids: ['a', 'b', 'c'] }, { id: 'act-r', rule_id: RULE })
    expect(iw.deleteLeads).toHaveBeenCalledWith(CID, ['a'])
    expect(r2).toMatchObject({ removed: 1, skipped: { bounced: 1, no_longer_finished: 1 } })
  })

  it('explicit ids from the agent may still remove a bounced lead (frees the cap)', async () => {
    il.getLeadsByIds.mockResolvedValue([fetched(lead('b', { status: -1, status_label: 'bounced' }))])
    iw.deleteLeads.mockResolvedValue(1)
    const r = await executeRemoveLeads({ ...p, lead_ids: ['b'] }, action)
    expect(r).toMatchObject({ removed: 1 })
  })

  it('nothing left to remove: deletes nothing', async () => {
    il.getLeadsByIds.mockResolvedValue([fetched(lead('a', { reply_count: 1 }))])
    const r = await executeRemoveLeads({ ...p, lead_ids: ['a'] }, action)
    expect(iw.deleteLeads).not.toHaveBeenCalled()
    expect(cs.insertCycledLeads).not.toHaveBeenCalled()
    expect(r).toMatchObject({ removed: 0, skipped: { replied: 1 } })
  })

  it('a failed Instantly delete is uncertain and keeps the snapshots', async () => {
    il.getLeadsByIds.mockResolvedValue([fetched(lead('a'))])
    iw.deleteLeads.mockRejectedValue(new Error('500'))
    const err = await executeRemoveLeads(p, action).catch((e) => e)
    expect(err).toBeInstanceOf(RemovalFailure)
    expect(err.result).toMatchObject({ uncertain: true, removed: 0 })
    expect(cs.insertCycledLeads).toHaveBeenCalled()
  })

  it('a snapshot failure on a later chunk is uncertain and reports what was already removed', async () => {
    const many = Array.from({ length: 150 }, (_, i) => lead(`id${i}`))
    il.getLeadsByIds.mockResolvedValue(many.map(fetched))
    iw.deleteLeads.mockResolvedValue(100)
    cs.insertCycledLeads.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('db down'))
    const err = await executeRemoveLeads({ ...p, lead_ids: many.map((l) => l.id), count: 150 }, action).catch((e) => e)
    expect(err).toBeInstanceOf(RemovalFailure)
    expect(err.message).toMatch(/snapshot failed after 100 removed/)
    expect(err.result).toMatchObject({ uncertain: true, removed: 100, instantly_deleted: 100 })
    expect(iw.deleteLeads).toHaveBeenCalledTimes(1) // the unsnapshotted chunk is never deleted
  })

  it('a snapshot failure before anything was removed is a plain failure', async () => {
    il.getLeadsByIds.mockResolvedValue([fetched(lead('a'))])
    cs.insertCycledLeads.mockRejectedValueOnce(new Error('db down'))
    const err = await executeRemoveLeads(p, action).catch((e) => e)
    expect(err).toBeInstanceOf(RemovalFailure)
    expect(err.result).toMatchObject({ removed: 0 })
    expect(err.result.uncertain).toBeUndefined()
    expect(iw.deleteLeads).not.toHaveBeenCalled()
  })

  it('refuses a malformed payload', async () => {
    await expect(executeRemoveLeads({ campaign_id: CID }, action)).rejects.toBeInstanceOf(RemovalFailure)
    expect(il.getLeadsByIds).not.toHaveBeenCalled()
  })

  it('a cycle-out rule refills to refill_to with an assign_leads action', async () => {
    svc.getRule.mockResolvedValue({
      id: RULE, name: 'Cycle', campaign_id: CID, filter: { city: 'Austin' }, order_by: 'newest', daily_cap: 1000, kind: 'cycle_out', params: { after_days: 14, refill_to: 1000 },
    })
    il.getLeadsByIds.mockResolvedValue([fetched(lead('a')), fetched(lead('b'))])
    il.getCampaignLeadCount.mockResolvedValue(900)
    iw.deleteLeads.mockResolvedValue(2)
    cs.countQueuedForCampaign.mockResolvedValue(50)
    svc.countCandidates.mockResolvedValue(5000)
    svc.getCampaignByExternalId.mockResolvedValue({ name: 'Kaspen PM' })
    cr.createAction.mockResolvedValue({ id: 'refill-1' })
    const r = await executeRemoveLeads({ ...p, lead_ids: ['a', 'b'] }, { id: 'act-2', rule_id: RULE })
    // 1000 target − (900 − 2 removed) − 50 queued = 52
    expect(cr.createAction).toHaveBeenCalledWith(
      'assign_leads',
      expect.objectContaining({ campaign_id: CID, campaign_name: 'Kaspen PM', filter: { city: 'Austin' }, count: 52, rule_id: RULE }),
      'rule',
      { ruleId: RULE }
    )
    expect(r.refill).toEqual({ action_id: 'refill-1', count: 52, in_campaign: 898, queued: 50, available: 5000 })
  })

  it('refill already awaiting → reported, removal still succeeds', async () => {
    svc.getRule.mockResolvedValue({ id: RULE, name: 'C', campaign_id: CID, filter: {}, order_by: 'oldest', daily_cap: 1, kind: 'cycle_out', params: { after_days: 14, refill_to: 10 } })
    il.getLeadsByIds.mockResolvedValue([fetched(lead('a'))])
    il.getCampaignLeadCount.mockResolvedValue(5)
    iw.deleteLeads.mockResolvedValue(1)
    cs.countQueuedForCampaign.mockResolvedValue(0)
    svc.countCandidates.mockResolvedValue(100)
    svc.getCampaignByExternalId.mockResolvedValue(null)
    cr.createAction.mockRejectedValue(new cr.DuplicateActionError('old'))
    const r = await executeRemoveLeads({ ...p, lead_ids: ['a'] }, { id: 'act-3', rule_id: RULE })
    expect(r).toMatchObject({ removed: 1, refill: { skipped: 'action_awaiting', action_id: 'old' } })
  })
})
