import { describe, expect, it } from 'vitest'
import { grantBlocker, looksLikeOptOut, parseReplyMode, REPLY_MODES } from '@/lib/inbox/replyMode'

const good = { campaign_id: 'c-1', campaign_verified: true, verdict: 'GOOD', their_message: 'Sounds good, Tuesday works.', recipient_verified: true }
const ctx = (extra: Partial<Parameters<typeof grantBlocker>[0]> = {}) => ({ mode: 'auto' as const, payload: good, reply: null, leadReplies: [], ...extra })

describe('reply modes', () => {
  it('owner | client | auto, owner by default', () => {
    expect(REPLY_MODES).toEqual(['owner', 'client', 'auto'])
    expect(parseReplyMode('auto')).toBe('auto')
    expect(parseReplyMode(undefined)).toBe('owner')
    expect(parseReplyMode('everyone')).toBe('owner')
  })
})

describe('grantBlocker (Auto mode is the only path that approves a reply with nobody tapping)', () => {
  it('a GOOD reply on an auto campaign is granted', () => {
    expect(grantBlocker(ctx())).toBeNull()
  })

  it('owner and client modes never grant (client behaves like owner until 3g)', () => {
    expect(grantBlocker(ctx({ mode: 'owner' }))).toBe('mode_owner')
    expect(grantBlocker(ctx({ mode: 'client' }))).toBe('mode_client')
  })

  it('needs a campaign and a verdict of GOOD', () => {
    expect(grantBlocker(ctx({ payload: { ...good, campaign_id: undefined } }))).toBe('no_campaign')
    expect(grantBlocker(ctx({ payload: { ...good, verdict: 'BAD' } }))).toBe('verdict_bad')
    expect(grantBlocker(ctx({ payload: { ...good, verdict: 'UNSURE' } }))).toBe('verdict_not_good')
    expect(grantBlocker(ctx({ payload: { ...good, verdict: undefined } }))).toBe('verdict_not_good')
  })

  it('needs a server-verified campaign (the email named it)', () => {
    expect(grantBlocker(ctx({ payload: { ...good, campaign_verified: undefined } }))).toBe('campaign_unverified')
    expect(grantBlocker(ctx({ payload: { ...good, campaign_verified: false } }))).toBe('campaign_unverified')
  })

  it('an unverified recipient or a missing lead message is held', () => {
    expect(grantBlocker(ctx({ payload: { ...good, recipient_verified: false } }))).toBe('recipient_unverified')
    expect(grantBlocker(ctx({ payload: { ...good, their_message: '' } }))).toBe('no_lead_message')
  })

  it('never for an unsubscribe or hostile message', () => {
    expect(grantBlocker(ctx({ payload: { ...good, their_message: 'Please unsubscribe me.' } }))).toBe('opt_out_or_hostile')
    expect(grantBlocker(ctx({ payload: { ...good, their_message: 'This is spam, stop emailing me' } }))).toBe('opt_out_or_hostile')
  })

  it('never when the reply or any earlier reply of the lead was labelled BAD, unsubscribe, hostile or not interested', () => {
    expect(grantBlocker(ctx({ reply: { handled_how: 'label:ooo', interest: 1 } }))).toBe('reply_labeled')
    expect(grantBlocker(ctx({ reply: { handled_how: null, interest: -1 } }))).toBe('negative_interest')
    for (const how of ['label:bad_fit', 'label:unsubscribe', 'label:hostile', 'label:not_interested']) {
      expect(grantBlocker(ctx({ leadReplies: [{ handled_how: 'replied' }, { handled_how: how }] }))).toBe('lead_labeled_negative')
    }
    expect(grantBlocker(ctx({ leadReplies: [{ handled_how: 'replied' }, { handled_how: 'label:interested' }] }))).toBeNull()
  })
})

describe('looksLikeOptOut', () => {
  it.each([
    'unsubscribe', 'Remove me from your list', 'take me off this list', 'stop emailing me', "don't contact me again", 'Do not email me',
    'opt out', 'not interested', 'leave me alone', 'this is a scam', 'f*** off', 'fuck off', 'I will report this as spam',
  ])('%s', (t) => expect(looksLikeOptOut(t)).toBe(true))
  it.each(['Sounds good, Tuesday works.', 'What does it cost?', 'Can you send more info?', 'Interested! When?'])('%s is fine', (t) =>
    expect(looksLikeOptOut(t)).toBe(false)
  )
})
