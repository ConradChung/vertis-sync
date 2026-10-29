import { describe, expect, it } from 'vitest'
import {
  excerptOf,
  INTEREST,
  interestLabel,
  isPositiveWebhook,
  labelPlan,
  mapInboxEmail,
  recheckThread,
  threadView,
  trimQuotes,
} from '@/lib/inbox/model'

const raw = (o: Record<string, unknown>) => ({
  id: 'e1',
  thread_id: 't1',
  ue_type: 2,
  eaccount: 'frank@ours.com',
  from_address_email: 'lead@acme.com',
  to_address_email_list: 'frank@ours.com',
  subject: 'Re: hello',
  body: { text: 'Yes, interested.' },
  timestamp_email: '2026-10-28T10:00:00.000Z',
  campaign_id: 'c1',
  lead: 'lead@acme.com',
  i_status: 1,
  is_unread: 1,
  ...o,
})

describe('trimQuotes', () => {
  it('drops "On … wrote:" and everything after it', () => {
    expect(trimQuotes('Sounds good, Tuesday works.\n\nOn Mon, Oct 27, 2026 at 9:00 AM Frank <frank@ours.com> wrote:\n> Hi Ada,\n> quick question')).toBe(
      'Sounds good, Tuesday works.'
    )
  })
  it('drops > quoted lines and Outlook headers', () => {
    expect(trimQuotes('Not now.\n> old text\n> more')).toBe('Not now.')
    expect(trimQuotes('Call me.\n\n-----Original Message-----\nFrom: Frank\nSent: Monday')).toBe('Call me.')
    expect(trimQuotes('Call me.\n\nFrom: Frank <frank@ours.com>\nSent: Monday, October 27\nTo: Ada')).toBe('Call me.')
    expect(trimQuotes('Yes\n________________________________\nFrom: Frank')).toBe('Yes')
  })
  it('a wrapped "On … wrote:" over two lines is still cut', () => {
    expect(trimQuotes('Yes please\n\nOn Mon, Oct 27, 2026 at 9:00 AM Frank Smith <\nfrank@ours.com> wrote:\n> x')).toBe('Yes please')
  })
  it('keeps a message that is only quotes rather than returning nothing', () => {
    expect(trimQuotes('> only a quote')).toBe('> only a quote')
  })
  it('collapses long blank runs', () => {
    expect(trimQuotes('a\n\n\n\n\nb')).toBe('a\n\nb')
  })
})

describe('mapInboxEmail', () => {
  it('maps an inbound email', () => {
    expect(mapInboxEmail(raw({}))).toMatchObject({
      id: 'e1', thread_id: 't1', direction: 'in', eaccount: 'frank@ours.com', from: 'lead@acme.com', lead: 'lead@acme.com',
      subject: 'Re: hello', text: 'Yes, interested.', at: '2026-10-28T10:00:00.000Z', campaign_id: 'c1', interest: 1, unread: true,
    })
  })
  it('an outbound email (ue_type 1) and HTML bodies', () => {
    const m = mapInboxEmail(raw({ ue_type: 1, from_address_email: 'frank@ours.com', body: { html: '<p>Hi<br>there</p>' } }))
    expect(m?.direction).toBe('out')
    expect(m?.text).toBe('Hi\nthere')
  })
  it('cc list is kept (reply-all)', () => {
    expect(mapInboxEmail(raw({ cc_address_email_list: 'boss@acme.com, x@acme.com' }))?.cc).toEqual(['boss@acme.com', 'x@acme.com'])
  })
  it('unknown shapes → null', () => {
    expect(mapInboxEmail(null)).toBeNull()
    expect(mapInboxEmail({ subject: 'no id' })).toBeNull()
  })
})

describe('threadView / recheckThread', () => {
  const a = mapInboxEmail(raw({ id: 'o1', ue_type: 1, from_address_email: 'frank@ours.com', timestamp_email: '2026-10-27T09:00:00.000Z', body: { text: 'Hi Ada' } }))!
  const b = mapInboxEmail(raw({ id: 'i1', timestamp_email: '2026-10-28T10:00:00.000Z', body: { text: 'Yes\n\nOn Mon Frank wrote:\n> Hi Ada' } }))!
  const c = mapInboxEmail(raw({ id: 'i2', timestamp_email: '2026-10-28T11:00:00.000Z', body: { text: 'Also, Tuesday?' } }))!

  it('oldest → newest, quotes trimmed, latest inbound to reply to', () => {
    const t = threadView([c, a, b])
    expect(t.messages.map((m) => m.id)).toEqual(['o1', 'i1', 'i2'])
    expect(t.messages[1].untrusted_text).toBe('Yes')
    expect(t.messages[0].text).toBe('Hi Ada')
    expect(t.latest_inbound).toEqual({ reply_to_uuid: 'i2', eaccount: 'frank@ours.com', subject: 'Re: hello', at: '2026-10-28T11:00:00.000Z' })
    expect(t.lead_email).toBe('lead@acme.com')
  })
  const at = (m: typeof a, iso: string | null, created: string | null = null) => ({ ...m, at: iso, created_at: created })

  it('recheckThread: safe when nothing came after the answered message', () => {
    expect(recheckThread([a, b], 'i1')).toEqual({ ok: true })
  })
  it('recheckThread: a later inbound → newer_inbound, regardless of list order', () => {
    expect(recheckThread([c, b, a], 'i1')).toMatchObject({ ok: false, code: 'newer_inbound', email: { id: 'i2' } })
  })
  it('recheckThread: an inbound in the same second counts as newer', () => {
    const same = at(c, '2026-10-28T10:00:00.000Z')
    expect(recheckThread([a, b, same], 'i1')).toMatchObject({ ok: false, code: 'newer_inbound', email: { id: 'i2' } })
  })
  it('recheckThread: an inbound with an unparseable time counts as newer, even sorted first', () => {
    expect(recheckThread([at(c, 'not a date'), a, b], 'i1')).toMatchObject({ ok: false, code: 'newer_inbound' })
    expect(recheckThread([at(c, null), a, b], 'i1')).toMatchObject({ ok: false, code: 'newer_inbound' })
  })
  it('recheckThread: timestamp_created wins over timestamp_email', () => {
    // the server's email time says earlier, but Instantly received it after the answered one
    const late = at(c, '2026-10-27T00:00:00.000Z', '2026-10-28T12:00:00.000Z')
    expect(recheckThread([a, b, late], 'i1')).toMatchObject({ ok: false, code: 'newer_inbound' })
    const early = at(c, '2026-10-29T00:00:00.000Z', '2026-10-27T12:00:00.000Z')
    expect(recheckThread([a, b, early], 'i1')).toEqual({ ok: true })
  })
  it('recheckThread: an outbound after the answered message (our reply, a manual Unibox reply) → already_replied', () => {
    const ours = mapInboxEmail(raw({ id: 'o2', ue_type: 1, from_address_email: 'frank@ours.com', timestamp_email: '2026-10-28T12:00:00.000Z' }))!
    expect(recheckThread([a, b, ours], 'i1')).toMatchObject({ ok: false, code: 'already_replied', email: { id: 'o2' } })
  })
  it('recheckThread: the answered message missing from the thread (or an empty thread) → thread_unverifiable', () => {
    expect(recheckThread([a, c], 'i1')).toEqual({ ok: false, code: 'thread_unverifiable', email: null })
    expect(recheckThread([], 'i1')).toEqual({ ok: false, code: 'thread_unverifiable', email: null })
  })
  it('recheckThread: the answered message has no usable time → thread_unverifiable', () => {
    expect(recheckThread([a, at(b, null)], 'i1')).toMatchObject({ ok: false, code: 'thread_unverifiable' })
  })
})

describe('isPositiveWebhook', () => {
  it('lead_interested is positive', () => {
    expect(isPositiveWebhook('interested', {})).toBe(true)
  })
  it('a reply is positive only when it carries an interested status', () => {
    expect(isPositiveWebhook('reply', {})).toBe(false)
    expect(isPositiveWebhook('reply', { lt_interest_status: 1 })).toBe(true)
    expect(isPositiveWebhook('reply', { interest_status: '1' })).toBe(true)
    expect(isPositiveWebhook('reply', { i_status: 1 })).toBe(true)
    expect(isPositiveWebhook('reply', { ai_interest_value: 0.9 })).toBe(false)
    expect(isPositiveWebhook('reply', { lt_interest_status: -1 })).toBe(false)
  })
  it('other events are not', () => {
    expect(isPositiveWebhook('bounce', { lt_interest_status: 1 })).toBe(false)
  })
})

describe('labelPlan', () => {
  it('maps categories onto Instantly interest, CRM stage and blocklist', () => {
    expect(labelPlan({ category: 'interested' })).toMatchObject({ interest: INTEREST.interested, stage: 'Interested', close: null, block: false, handled: false })
    expect(labelPlan({ category: 'not_now' })).toMatchObject({ interest: undefined, stage: 'Not now', handled: false })
    expect(labelPlan({ category: 'wrong_person' })).toMatchObject({ interest: INTEREST.wrong_person, stage: null, handled: false })
    expect(labelPlan({ category: 'ooo' })).toMatchObject({ interest: INTEREST.ooo, stage: null, handled: true })
    expect(labelPlan({ category: 'not_interested' })).toMatchObject({ interest: INTEREST.not_interested, close: 'Lost', block: false, handled: true })
    expect(labelPlan({ category: 'unsubscribe' })).toMatchObject({ interest: INTEREST.not_interested, close: 'Lost', block: true, handled: true })
    expect(labelPlan({ category: 'hostile' })).toMatchObject({ block: true, close: 'Lost' })
    expect(labelPlan({ category: 'booked' })).toMatchObject({ interest: INTEREST.meeting_booked, stage: 'Meeting booked', meeting: true, handled: true })
  })
  it('BAD: lost, blocked only when asked', () => {
    expect(labelPlan({ verdict: 'BAD' })).toMatchObject({ interest: INTEREST.lost, close: 'Lost', block: false, handled: true })
    expect(labelPlan({ verdict: 'BAD', block: true })).toMatchObject({ block: true })
  })
  it('block is never added for a GOOD lead by the flag alone', () => {
    expect(labelPlan({ category: 'interested', verdict: 'GOOD', block: true }).block).toBe(false)
  })
  it('a verdict without a category, other than BAD, is refused', () => {
    expect(() => labelPlan({ verdict: 'GOOD' })).toThrow(/category/)
  })
})

describe('small helpers', () => {
  it('interestLabel', () => {
    expect(interestLabel(1)).toBe('interested')
    expect(interestLabel(-2)).toBe('wrong person')
    expect(interestLabel(null)).toBeNull()
    expect(interestLabel(77)).toBe('custom (77)')
  })
  it('excerptOf trims quotes and caps length', () => {
    expect(excerptOf('Yes\n> quoted', 300)).toBe('Yes')
    expect(excerptOf('x'.repeat(400), 300)).toHaveLength(300)
  })
})
