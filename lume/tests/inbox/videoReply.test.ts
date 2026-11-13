import { describe, expect, it } from 'vitest'
import { askedVideo, isPlainYes, videoBlocker, videoReplyBody, VIDEO_REPLY_DRAFTED_BY } from '@/lib/inbox/videoReply'

const UK = '25c80373-b5c1-4b46-bb47-2faf37c8bd1e'

describe('isPlainYes', () => {
  it.each([
    'Yes',
    'yes please',
    'Sure, send it over',
    'Yeah sure!',
    'Hi Frank, yes please. Thanks',
    'Ok',
    'Sounds good 👍',
    'Absolutely, would love to see it',
    'Yes please\n\nJohn Smith\nDirector\nAcme Property Management\n555-0100',
    'Sure\n\nSent from my iPhone',
  ])('accepts %j', (t) => expect(isPlainYes(t)).toBe(true))

  it.each([
    '',
    'Yes, how much does it cost?',
    'Sure but we use Yardi',
    'Not interested',
    'No thanks',
    'yes but only if it works with Rent Manager',
    'Please remove me',
    'Yes\n\nWe already use another tool for this and are happy with it.',
    'Can you send it?',
    'Stop',
    'We are a commercial-only shop, sure',
  ])('rejects %j', (t) => expect(isPlainYes(t)).toBe(false))
})

describe('videoReplyBody', () => {
  it('uses the first name and company, with the audit offer at the bottom', () => {
    const b = videoReplyBody('Ann Lee', 'Acme PM')
    expect(b.startsWith('Hi Ann,\n\nHere you go: https://kaspen.ai.')).toBe(true)
    expect(b).toContain('"Talk to Kaspen"')
    expect(b).toContain("Want a free 15-min audit of where Acme PM's ops time goes?")
    expect(b.endsWith('\n\nFrank')).toBe(true)
  })
  it('falls back when name or company is unknown', () => {
    const b = videoReplyBody(null, null)
    expect(b.startsWith('Hi there,')).toBe(true)
    expect(b).toContain('where your team’s ops time goes?')
  })
})

describe('askedVideo', () => {
  const out = (id: string, at: string, text: string) => ({ id, direction: 'out' as const, text, created_at: at, at })
  const inn = (id: string, at: string) => ({ id, direction: 'in' as const, text: 'yes', created_at: at, at })
  const Q = 'blah\nOpen to seeing a 2-min video of how it dispatches work orders?\n\nFrank'
  it('is true when our last email before the yes asked the video question', () => {
    expect(askedVideo([out('o1', '2026-11-10T10:00:00Z', Q), inn('i1', '2026-11-11T10:00:00Z')], 'i1')).toBe(true)
  })
  it('is false when a later email (a follow-up) asked something else', () => {
    expect(askedVideo([out('o1', '2026-11-10T10:00:00Z', Q), out('o2', '2026-11-11T09:00:00Z', 'Quick follow up?'), inn('i1', '2026-11-11T10:00:00Z')], 'i1')).toBe(false)
  })
  it('is false when the answered email is not in the thread', () => {
    expect(askedVideo([out('o1', '2026-11-10T10:00:00Z', Q)], 'i1')).toBe(false)
  })
})

describe('videoBlocker', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    campaign_id: UK,
    reply_to_uuid: 'r1',
    lead_name: 'Ann Lee',
    company: 'Acme PM',
    body: videoReplyBody('Ann Lee', 'Acme PM'),
    drafted_by: VIDEO_REPLY_DRAFTED_BY,
    ...over,
  })
  const ok = { message: 'Yes please', leadReplies: [{ reply_to_uuid: 'r1' }], asked: true }
  it('passes the exact template on a first plain yes to the video question', () => {
    expect(videoBlocker({ payload: payload(), ...ok })).toBeNull()
  })
  it('holds anything else for a person', () => {
    expect(videoBlocker({ payload: payload({ campaign_id: 'other' }), ...ok })).toBe('video_not_campaign')
    expect(videoBlocker({ payload: payload({ body: 'Hi Ann, edited' }), ...ok })).toBe('video_not_template')
    expect(videoBlocker({ payload: payload(), ...ok, asked: false })).toBe('video_not_asked')
    expect(videoBlocker({ payload: payload(), ...ok, message: 'Yes, pricing?' })).toBe('video_not_plain_yes')
    expect(videoBlocker({ payload: payload(), ...ok, leadReplies: [{ reply_to_uuid: 'r0' }, { reply_to_uuid: 'r1' }] })).toBe('video_not_first_reply')
  })
})

describe('the 3-minute hold', () => {
  it('notYet holds an approved send_reply until send_after', async () => {
    const { notYet } = await import('@/lib/actions/execute')
    const at = '2026-11-12T10:03:00.000Z'
    const row = (status: string, kind = 'send_reply') => ({ kind, status, payload: { send_after: at } }) as never
    expect(notYet(row('approved'), Date.parse('2026-11-12T10:02:59Z'))).toBe(true)
    expect(notYet(row('approved'), Date.parse('2026-11-12T10:03:01Z'))).toBe(false)
    expect(notYet(row('awaiting'), Date.parse('2026-11-12T10:00:00Z'))).toBe(false)
    expect(notYet({ kind: 'send_reply', status: 'approved', payload: {} } as never)).toBe(false)
  })
})
