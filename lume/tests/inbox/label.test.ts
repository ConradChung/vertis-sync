import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxEmail } from '@/lib/inbox/model'

const h = vi.hoisted(() => ({
  getEmail: vi.fn(),
  setInterestStatus: vi.fn(),
  addToBlocklist: vi.fn(),
  ensureDeal: vi.fn(),
  setStage: vi.fn(),
  addActivity: vi.fn(),
  createAction: vi.fn(),
  closeReply: vi.fn(),
  markLeadRepliesHandled: vi.fn(),
  logEvent: vi.fn(),
}))
vi.mock('@/lib/adapters/instantlyEmails', () => ({ getEmail: h.getEmail }))
vi.mock('@/lib/adapters/instantlyLabels', () => ({ setInterestStatus: h.setInterestStatus, addToBlocklist: h.addToBlocklist }))
vi.mock('@/lib/crm/service', () => ({ ensureDeal: h.ensureDeal, setStage: h.setStage, addActivity: h.addActivity }))
vi.mock('@/lib/actions/create', () => ({
  createAction: h.createAction,
  DuplicateActionError: class DuplicateActionError extends Error {
    constructor(readonly existingId: string) {
      super('dup')
      this.name = 'DuplicateActionError'
    }
  },
}))
vi.mock('@/lib/inbox/replies', () => ({ closeReply: h.closeReply }))
vi.mock('@/lib/inbox/store', () => ({ markLeadRepliesHandled: h.markLeadRepliesHandled }))
vi.mock('@/lib/db/service', () => ({ logEvent: h.logEvent }))

import { applyLabel, logBooking } from '@/lib/inbox/label'
import { DuplicateActionError } from '@/lib/actions/create'

const C1 = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const C2 = '11111111-2222-4333-8444-555555555555'
const ALL = { all: true as const, operator: null }
const BOT = { all: false as const, operator: { id: 'op-1', vertical_id: 'v', is_master: false, label: 'bot', created_at: '', revoked_at: null, last_seen_at: null }, verticalId: 'v', campaignIds: [C1] }
const DEAL = { id: '7db3d841-252c-4572-95ec-bc110727df8d', stage: 'Replied', name: 'Ada', email: 'ada@acme.com', campaign_id: C1 }

const email = (o: Partial<InboxEmail> = {}): InboxEmail => ({
  id: 'e1', thread_id: 't1', direction: 'in', eaccount: 'f@ours.com', from: 'ada@acme.com', to: [], cc: [], lead: 'ada@acme.com',
  subject: 's', text: 't', at: null, campaign_id: C1, interest: 1, unread: false, auto_reply: false, ...o,
})

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.getEmail.mockResolvedValue(email())
  h.ensureDeal.mockResolvedValue(DEAL)
  h.setStage.mockResolvedValue('Replied')
  h.addActivity.mockResolvedValue({ id: 'act' })
  h.createAction.mockResolvedValue({ id: 'close-1' })
  h.markLeadRepliesHandled.mockResolvedValue([])
  h.addToBlocklist.mockResolvedValue('added')
})

describe('applyLabel', () => {
  it('interested: Instantly 1, CRM → Interested, a note; the reply stays open (a reply is still owed)', async () => {
    const out = await applyLabel({ reply_to_uuid: 'e1', category: 'interested', verdict: 'GOOD' }, ALL, 'agent')
    expect(h.setInterestStatus).toHaveBeenCalledWith('ada@acme.com', C1, 1)
    expect(h.setStage).toHaveBeenCalledWith(DEAL.id, 'Interested', 'agent', null, expect.objectContaining({ via: 'label_reply', category: 'interested' }))
    expect(h.addActivity).toHaveBeenCalledWith(expect.objectContaining({ deal_id: DEAL.id, kind: 'note', payload: expect.objectContaining({ category: 'interested', verdict: 'GOOD', by: 'agent' }) }))
    expect(h.addToBlocklist).not.toHaveBeenCalled()
    expect(h.closeReply).not.toHaveBeenCalled()
    expect(out).toMatchObject({ lead_email: 'ada@acme.com', campaign_id: C1, interest: 1, blocked: false, stage: { from: 'Replied', to: 'Interested' }, handled: false })
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'lume.reply_labeled', campaign_id: C1, lead_email: 'ada@acme.com' }))
  })

  it('not_now: Instantly untouched, CRM → Not now', async () => {
    const out = await applyLabel({ reply_to_uuid: 'e1', category: 'not_now' }, ALL, 'owner')
    expect(h.setInterestStatus).not.toHaveBeenCalled()
    expect(h.setStage).toHaveBeenCalledWith(DEAL.id, 'Not now', 'user', null, expect.anything())
    expect(out.interest).toBe('unchanged')
  })

  it('unsubscribe: not interested + blocklisted + a Lost close filed for approval; the reply is handled', async () => {
    const out = await applyLabel({ reply_to_uuid: 'e1', category: 'unsubscribe' }, ALL, 'agent')
    expect(h.setInterestStatus).toHaveBeenCalledWith('ada@acme.com', C1, -1)
    expect(h.addToBlocklist).toHaveBeenCalledWith('ada@acme.com')
    expect(h.createAction).toHaveBeenCalledWith('crm_close_deal', expect.objectContaining({ deal_id: DEAL.id, stage: 'Lost', reason: expect.stringContaining('unsubscribe') }), 'agent')
    expect(h.setStage).not.toHaveBeenCalled()
    expect(h.closeReply).toHaveBeenCalledWith('e1', 'label:unsubscribe', { operatorId: null })
    expect(h.markLeadRepliesHandled).toHaveBeenCalledWith(C1, 'ada@acme.com', 'label:unsubscribe')
    expect(out).toMatchObject({ blocked: true, close_action_id: 'close-1', handled: true })
  })

  it('a Lost close already awaiting is reused, not refiled', async () => {
    h.createAction.mockRejectedValue(new DuplicateActionError('close-0'))
    expect((await applyLabel({ reply_to_uuid: 'e1', category: 'hostile' }, ALL, 'owner')).close_action_id).toBe('close-0')
  })

  it('a deal already Lost or Won: no close filed, no stage move', async () => {
    h.ensureDeal.mockResolvedValue({ ...DEAL, stage: 'Lost' })
    await applyLabel({ reply_to_uuid: 'e1', category: 'not_interested' }, ALL, 'owner')
    expect(h.createAction).not.toHaveBeenCalled()
    h.ensureDeal.mockResolvedValue({ ...DEAL, stage: 'Won' })
    await applyLabel({ reply_to_uuid: 'e1', category: 'interested' }, ALL, 'owner')
    expect(h.setStage).not.toHaveBeenCalled()
  })

  it('BAD: lost (-3), blocked only with block', async () => {
    await applyLabel({ reply_to_uuid: 'e1', verdict: 'BAD' }, ALL, 'agent')
    expect(h.setInterestStatus).toHaveBeenCalledWith('ada@acme.com', C1, -3)
    expect(h.addToBlocklist).not.toHaveBeenCalled()
    await applyLabel({ reply_to_uuid: 'e1', verdict: 'BAD', block: true }, ALL, 'agent')
    expect(h.addToBlocklist).toHaveBeenCalledWith('ada@acme.com')
  })

  it('by lead + campaign, no reply id: no Instantly email read', async () => {
    await applyLabel({ lead_email: 'Bob@Acme.com', campaign_id: C1, category: 'ooo', note: 'back Nov 4' }, ALL, 'owner')
    expect(h.getEmail).not.toHaveBeenCalled()
    expect(h.setInterestStatus).toHaveBeenCalledWith('bob@acme.com', C1, 0)
    expect(h.addActivity).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ text: expect.stringContaining('back Nov 4') }) }))
  })

  it('scope: a vertical bot cannot label another campaign (no Instantly write)', async () => {
    h.getEmail.mockResolvedValue(email({ campaign_id: C2 }))
    await expect(applyLabel({ reply_to_uuid: 'e1', category: 'interested' }, BOT, 'operator:op-1')).rejects.toMatchObject({ status: 403 })
    await expect(applyLabel({ lead_email: 'a@b.co', campaign_id: C2, category: 'ooo' }, BOT, 'operator:op-1')).rejects.toMatchObject({ status: 403 })
    expect(h.setInterestStatus).not.toHaveBeenCalled()
  })

  it('an unknown email: 404; an outbound one: 400', async () => {
    h.getEmail.mockResolvedValue(null)
    await expect(applyLabel({ reply_to_uuid: 'x', category: 'ooo' }, ALL, 'owner')).rejects.toMatchObject({ status: 404 })
    h.getEmail.mockResolvedValue(email({ direction: 'out' }))
    await expect(applyLabel({ reply_to_uuid: 'x', category: 'ooo' }, ALL, 'owner')).rejects.toMatchObject({ status: 400, code: 'not_an_inbound_email' })
  })

  it('Instantly fails: nothing in the CRM changes', async () => {
    h.setInterestStatus.mockRejectedValue(new Error('Instantly 500'))
    await expect(applyLabel({ reply_to_uuid: 'e1', category: 'interested' }, ALL, 'owner')).rejects.toThrow('Instantly 500')
    expect(h.ensureDeal).not.toHaveBeenCalled()
  })
})

describe('logBooking', () => {
  it('booked: Instantly meeting booked (2), CRM → Meeting booked, a meeting activity deduped on the event id, reply handled', async () => {
    h.setStage.mockResolvedValue('Interested')
    const out = await logBooking(
      { reply_to_uuid: 'e1', time: '2026-11-03T17:00:00-08:00', event_id: 'cal-123', event_link: 'https://calendly.com/x/abc', notes: 'wants pricing' },
      ALL,
      'operator:op-1'
    )
    expect(h.setInterestStatus).toHaveBeenCalledWith('ada@acme.com', C1, 2)
    expect(h.setStage).toHaveBeenCalledWith(DEAL.id, 'Meeting booked', 'agent', null, expect.objectContaining({ via: 'log_booking' }))
    expect(h.addActivity).toHaveBeenCalledWith({
      deal_id: DEAL.id,
      kind: 'meeting',
      source: 'agent',
      payload: { time: '2026-11-03T17:00:00-08:00', event_id: 'cal-123', event_link: 'https://calendly.com/x/abc', notes: 'wants pricing', by: 'operator:op-1' },
      dedupe_key: `booking:${C1}:cal-123`,
    })
    expect(out).toMatchObject({ handled: true, stage: { from: 'Interested', to: 'Meeting booked' }, meeting: true })
  })

  it('no event id: the meeting activity is not deduped', async () => {
    await logBooking({ lead_email: 'ada@acme.com', campaign_id: C1, time: '2026-11-03T17:00:00Z' }, ALL, 'owner')
    expect(h.addActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'meeting', dedupe_key: null, source: 'user' }))
  })
})
