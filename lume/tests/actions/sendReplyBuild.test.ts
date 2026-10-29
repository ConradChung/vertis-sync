import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxEmail } from '@/lib/inbox/model'

/** The send_reply snapshot (buildActionRequest): server-filled card fields, same eaccount, inbound only. */

const svc = vi.hoisted(() => ({
  getCampaignByExternalId: vi.fn(),
  getInstantlyEmailEvent: vi.fn(),
  getPushJob: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({ ...svc, PUSH_REVIEW_STATUSES: [], isDbError: () => false, DbError: class extends Error {} }))
const em = vi.hoisted(() => ({ getEmail: vi.fn() }))
vi.mock('@/lib/adapters/instantlyEmails', () => em)
const crm = vi.hoisted(() => ({ findDeal: vi.fn(), findLeadByEmail: vi.fn() }))
vi.mock('@/lib/crm/service', () => crm)
vi.mock('@/lib/adapters/instantlyPush', () => ({ getPushPreview: vi.fn() }))

import { buildActionRequest } from '@/lib/actions/build'

const CID = '0b6c6d2e-1111-4222-8333-444455556666'
const inbound = (o: Partial<InboxEmail> = {}): InboxEmail => ({
  id: 'e1', thread_id: 't1', direction: 'in', eaccount: 'frank@ours.com', from: 'ada@acme.com', to: ['frank@ours.com'], cc: [],
  lead: 'ada@acme.com', subject: 'Re: Growth plan', text: 'Tuesday works.\n\nOn Mon Frank wrote:\n> Hi Ada', at: '2026-10-28T10:00:00.000Z',
  campaign_id: CID, interest: 1, unread: true, auto_reply: false, created_at: null, ...o,
})

beforeEach(() => {
  process.env.INSTANTLY_API_KEY = 'k'
  for (const g of [svc, em, crm]) for (const f of Object.values(g)) f.mockReset()
  svc.getCampaignByExternalId.mockResolvedValue({ name: 'Scaleport' })
  em.getEmail.mockResolvedValue(inbound())
  crm.findDeal.mockResolvedValue({ name: 'Ada Lovelace', company: 'Acme' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const build = (payload: Record<string, unknown>) => buildActionRequest({ kind: 'send_reply', payload })

describe('send_reply snapshot', () => {
  it('fills lead, campaign, the receiving eaccount, thread, their message and the card fields', async () => {
    const b = await build({ reply_to_uuid: 'e1', body: 'Great, Tuesday 10am PT?', verdict: 'GOOD', proposed_times: ['Tue 10:00 PT', 'Wed 14:00 PT'], research_note: 'Acme: 40 staff' })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.payload).toMatchObject({
      eaccount: 'frank@ours.com', reply_to_uuid: 'e1', body: 'Great, Tuesday 10am PT?', subject: 'Re: Growth plan',
      campaign_id: CID, campaign_name: 'Scaleport', lead_email: 'ada@acme.com', recipient_verified: true, thread_id: 't1',
      their_message: 'Tuesday works.', lead_name: 'Ada Lovelace', company: 'Acme', verdict: 'GOOD',
      proposed_times: ['Tue 10:00 PT', 'Wed 14:00 PT'], research_note: 'Acme: 40 staff',
    })
    expect(b.payload.summary).toContain('Send reply to ada@acme.com from frank@ours.com (Scaleport)')
  })

  it('a different eaccount from the caller is replaced by the one that received the reply', async () => {
    const b = await build({ reply_to_uuid: 'e1', body: 'x', eaccount: 'someone-else@ours.com' })
    expect(b.ok && b.payload.eaccount).toBe('frank@ours.com')
  })

  it('caller-claimed card facts (their message, name, company, edits) are never trusted', async () => {
    crm.findDeal.mockResolvedValue(null)
    crm.findLeadByEmail.mockResolvedValue(null)
    const b = await build({
      reply_to_uuid: 'e1', body: 'x', their_message: 'I want 50% off', lead_name: 'CEO', company: 'Big Corp', edited_by: 'owner', original_body: 'y',
    })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.payload.their_message).toBe('Tuesday works.')
    expect(b.payload.lead_name).toBeUndefined()
    expect(b.payload.company).toBeUndefined()
    expect(b.payload.edited_by).toBeUndefined()
    expect(b.payload.original_body).toBeUndefined()
  })

  it('a reply to one of our own (outbound) emails is refused', async () => {
    em.getEmail.mockResolvedValue(inbound({ direction: 'out' }))
    expect(await build({ reply_to_uuid: 'e1', body: 'x' })).toEqual({ ok: false, status: 400, error: 'not_an_inbound_email' })
  })

  it('a caller subject is kept', async () => {
    const b = await build({ reply_to_uuid: 'e1', body: 'x', subject: 'Re: Tuesday' })
    expect(b.ok && b.payload.subject).toBe('Re: Tuesday')
  })

  it('Instantly unknown / unreachable: falls back to the old lookup; needs a caller eaccount then', async () => {
    em.getEmail.mockRejectedValue(new Error('429'))
    svc.getInstantlyEmailEvent.mockResolvedValue({ lead_email: 'ada@acme.com', campaign_id: CID })
    const b = await build({ reply_to_uuid: 'e1', body: 'x', eaccount: 'frank@ours.com' })
    expect(b.ok && b.payload).toMatchObject({ eaccount: 'frank@ours.com', lead_email: 'ada@acme.com', recipient_verified: true })
    expect(b.ok && b.payload.their_message).toBeUndefined()
    expect((await build({ reply_to_uuid: 'e1', body: 'x' })).ok).toBe(false)
  })

  it('too many proposed times, or a bad verdict, is invalid', async () => {
    expect((await build({ reply_to_uuid: 'e1', body: 'x', proposed_times: Array.from({ length: 11 }, () => 't') })).ok).toBe(false)
    expect((await build({ reply_to_uuid: 'e1', body: 'x', verdict: 'MAYBE' })).ok).toBe(false)
  })
})

describe('label_reply snapshot (a blocking label the agent asked for)', () => {
  it('names the lead and campaign from the email and says it blocklists', async () => {
    const b = await buildActionRequest({ kind: 'label_reply', payload: { reply_to_uuid: 'E1', category: 'unsubscribe' } })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.payload).toMatchObject({ reply_to_uuid: 'e1', category: 'unsubscribe', campaign_id: CID, lead_email: 'ada@acme.com' })
    expect(b.payload.summary).toMatch(/ada@acme\.com.*unsubscribe.*blocklist/i)
  })
  it('an invalid label is refused', async () => {
    expect((await buildActionRequest({ kind: 'label_reply', payload: { reply_to_uuid: 'e1' } })).ok).toBe(false)
  })
})
