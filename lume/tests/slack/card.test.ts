import { describe, expect, it } from 'vitest'
import { buildCard, buildEditModal, CARD_FIELDS, esc, parseVisibleFields, showButtons, type CardInput, type LeadFacts } from '@/lib/slack/card'
import { channelCampaigns, channelCoversCampaign, mergeFacts } from '@/lib/slack/binding'
import { clientDecisionError } from '@/lib/slack/policy'

const facts: LeadFacts = {
  name: 'Ada Lovelace', title: 'CTO', company: 'Acme', website: 'acme.com', phone: null,
  linkedin: 'https://linkedin.com/in/ada', location: 'London', reply: 'Tuesday works', stage: 'Replied',
}
const awaiting = (over: Partial<Extract<CardInput['draft'], { kind: 'action' }>> = {}): CardInput['draft'] => ({
  kind: 'action', action_id: 'a-1', status: 'awaiting', body: 'Great, Tuesday 10am?', decided_via: null,
  decided_by_slack_user: null, edited_by_slack_user: null, error_code: null, ...over,
})
const input = (over: Partial<CardInput> = {}): CardInput => ({ facts, visible: [...CARD_FIELDS], mode: 'client', optOut: false, draft: awaiting(), ...over })
const json = (c: CardInput) => JSON.stringify(buildCard(c))
const actionsBlock = (c: CardInput) => buildCard(c).blocks.find((b) => b.type === 'actions')

describe('buildCard', () => {
  it('shows every visible field, missing ones as missing (never invented)', () => {
    const out = json(input())
    for (const v of ['Ada Lovelace', 'CTO', 'Acme', 'acme.com', 'linkedin.com/in/ada', 'London', 'Tuesday works', 'Replied']) expect(out).toContain(v)
    expect(out).toContain('*Phone:* _missing_')
  })

  it('omits the fields the owner hid', () => {
    const out = json(input({ visible: ['name', 'company', 'reply'] }))
    expect(out).not.toContain('CTO')
    expect(out).not.toContain('linkedin.com')
    expect(out).not.toContain('Phone')
    expect(out).toContain('Ada Lovelace')
  })

  it('a hidden name never leaks through the fallback text', () => {
    expect(buildCard(input({ visible: ['company'] })).text).toBe('New positive reply from a lead at Acme')
  })

  it('escapes the lead\'s words: no @channel, no spoofed links', () => {
    const out = json(input({ facts: { ...facts, reply: '<!channel> click <https://evil.example|here>' } }))
    expect(out).not.toContain('<!channel>')
    expect(out).toContain('&lt;!channel&gt;')
    expect(esc('a & <b>')).toBe('a &amp; &lt;b&gt;')
  })

  it('Client mode + awaiting: Approve (with confirm), Edit and Skip carrying the action id', () => {
    const b = actionsBlock(input()) as { elements: { action_id: string; value: string; confirm?: unknown }[] }
    expect(b.elements.map((e) => e.action_id)).toEqual(['lume_approve', 'lume_edit', 'lume_skip'])
    expect(b.elements.every((e) => e.value === 'a-1')).toBe(true)
    expect(b.elements[0].confirm).toBeTruthy()
    expect(json(input())).toContain('Great, Tuesday 10am?')
  })

  it('Owner mode: no buttons, awaiting Conrad', () => {
    expect(actionsBlock(input({ mode: 'owner' }))).toBeUndefined()
    expect(json(input({ mode: 'owner' }))).toContain("Awaiting Conrad's approval")
  })

  it('Auto mode: no buttons', () => {
    expect(actionsBlock(input({ mode: 'auto' }))).toBeUndefined()
    expect(json(input({ mode: 'auto' }))).toContain('Auto mode')
  })

  it('a possible opt-out never gets buttons or a draft, in any mode', () => {
    for (const mode of ['client', 'owner', 'auto'] as const) {
      const c = input({ mode, optOut: true })
      expect(showButtons(c)).toBe(false)
      expect(actionsBlock(c)).toBeUndefined()
      expect(json(c)).not.toContain('Great, Tuesday 10am?')
    }
  })

  it('no draft yet: drafting, no buttons', () => {
    expect(actionsBlock(input({ draft: { kind: 'none' } }))).toBeUndefined()
    expect(json(input({ draft: { kind: 'none' } }))).toContain('Drafting a reply')
  })

  it('a client edit asks for a second approval', () => {
    expect(json(input({ draft: awaiting({ edited_by_slack_user: 'U123ABC' }) }))).toContain('Edited by <@U123ABC>')
  })

  it('outcomes replace the buttons', () => {
    const sent = input({ draft: awaiting({ status: 'executed', decided_via: 'client', decided_by_slack_user: 'U999XYZ' }) })
    expect(actionsBlock(sent)).toBeUndefined()
    expect(json(sent)).toContain('Sent (approved by <@U999XYZ>)')
    expect(json(input({ draft: awaiting({ status: 'rejected', decided_via: 'lume' }) }))).toContain('Skipped by Conrad')
    expect(json(input({ draft: awaiting({ status: 'failed', error_code: 'newer_inbound' }) }))).toContain('Not sent (newer_inbound)')
  })

  it('parseVisibleFields keeps known fields in card order', () => {
    expect(parseVisibleFields(['stage', 'name', 'bogus'])).toEqual(['name', 'stage'])
    expect(parseVisibleFields(null)).toEqual([...CARD_FIELDS])
  })

  it('the edit modal carries only the post id and the body', () => {
    const m = buildEditModal(42, 'hello') as { private_metadata: string; callback_id: string }
    expect(m.private_metadata).toBe('42')
    expect(m.callback_id).toBe('lume_edit_submit')
    expect(JSON.stringify(m)).toContain('hello')
  })
})

describe('channel bindings', () => {
  const verticals = [
    { id: 'v1', campaign_ids: ['c1', 'c2'], archived_at: null },
    { id: 'v2', campaign_ids: ['c3'], archived_at: '2026-10-01' },
  ]
  it('an empty campaign list means all of the vertical\'s campaigns', () => {
    const ch = { active: true, vertical_id: 'v1', campaign_ids: [] }
    expect(channelCoversCampaign(ch, verticals, 'c1')).toBe(true)
    expect(channelCoversCampaign(ch, verticals, 'c3')).toBe(false)
    expect(channelCampaigns(ch, verticals)).toEqual(['c1', 'c2'])
  })
  it('a campaign subset narrows it; a campaign off the vertical is never seen', () => {
    const ch = { active: true, vertical_id: 'v1', campaign_ids: ['c2', 'c9'] }
    expect(channelCoversCampaign(ch, verticals, 'c1')).toBe(false)
    expect(channelCoversCampaign(ch, verticals, 'c2')).toBe(true)
    expect(channelCoversCampaign(ch, verticals, 'c9')).toBe(false)
    expect(channelCampaigns(ch, verticals)).toEqual(['c2'])
  })
  it('inactive, archived, revoked or no campaign: nothing', () => {
    expect(channelCoversCampaign({ active: false, vertical_id: 'v1', campaign_ids: [] }, verticals, 'c1')).toBe(false)
    expect(channelCoversCampaign({ active: true, vertical_id: 'v2', campaign_ids: [] }, verticals, 'c3')).toBe(false)
    expect(channelCoversCampaign({ active: true, vertical_id: 'v1', campaign_ids: [] }, verticals, 'c1', false)).toBe(false)
    expect(channelCoversCampaign({ active: true, vertical_id: 'v1', campaign_ids: [] }, verticals, null)).toBe(false)
  })
})

describe('mergeFacts', () => {
  it('takes CRM, lead bank and the order row; leaves unknowns null', () => {
    const f = mergeFacts({
      reply: { lead_name: null, company: null, excerpt: 'Sounds good' },
      deal: { name: 'Ada L', company: 'Acme', city: null, stage: 'Replied' },
      lead: { first_name: 'Ada', last_name: 'Lovelace', company_name: 'Acme Ltd', website: null, location: null },
      order: { 'First Name': 'Ada', Title: 'CTO', 'Company Name': 'Acme', Website: 'acme.com', 'Corporate Phone': '+1 555', 'Person Linkedin Url': 'https://www.linkedin.com/in/ada', City: 'London', Country: 'UK' },
    })
    expect(f).toEqual({ name: 'Ada L', title: 'CTO', company: 'Acme', website: 'acme.com', phone: '+1 555', linkedin: 'https://www.linkedin.com/in/ada', location: 'London, UK', reply: 'Sounds good', stage: 'Replied' })
  })
  it('nothing known: every field null', () => {
    const f = mergeFacts({ reply: null, deal: null, lead: null, order: null })
    expect(Object.values(f).every((v) => v === null)).toBe(true)
  })
  it('a Google-Maps-style "title" with no company column is not a job title; a non-LinkedIn URL is not LinkedIn', () => {
    const f = mergeFacts({ reply: null, deal: null, lead: null, order: { title: "Joe's Roofing", linkedin: 'https://example.com' } })
    expect(f.title).toBeNull()
    expect(f.linkedin).toBeNull()
  })
})

describe('clientDecisionError', () => {
  const base = {
    decision: 'approve' as const, slackUser: 'U1AAA',
    action: { kind: 'send_reply', status: 'awaiting', payload: {}, edited_by_slack_user: null },
    covered: true, mode: 'client' as const, optOut: false,
  }
  it('allows an approval in Client mode from a bound channel', () => expect(clientDecisionError(base)).toBeNull())
  it('refuses outside Client mode', () => {
    expect(clientDecisionError({ ...base, mode: 'owner' })).toBe('not_client_mode')
    expect(clientDecisionError({ ...base, mode: 'auto' })).toBe('not_client_mode')
  })
  it('refuses an unbound channel, a decided row, another kind', () => {
    expect(clientDecisionError({ ...base, covered: false })).toBe('not_bound')
    expect(clientDecisionError({ ...base, action: { ...base.action, status: 'approved' } })).toBe('already_decided')
    expect(clientDecisionError({ ...base, action: { ...base.action, kind: 'pause_campaign' } })).toBe('not_send_reply')
  })
  it('refuses Approve and Edit on a possible opt-out (Skip is fine)', () => {
    expect(clientDecisionError({ ...base, optOut: true })).toBe('opt_out')
    expect(clientDecisionError({ ...base, optOut: true, decision: 'edit' })).toBe('opt_out')
    expect(clientDecisionError({ ...base, optOut: true, decision: 'skip' })).toBeNull()
  })
  it('the editor may not approve their own edit; another user may', () => {
    const edited = { ...base, action: { ...base.action, edited_by_slack_user: 'U1AAA' } }
    expect(clientDecisionError(edited)).toBe('self_edit')
    expect(clientDecisionError({ ...edited, slackUser: 'U2BBB' })).toBeNull()
    expect(clientDecisionError({ ...edited, decision: 'skip' })).toBeNull()
    expect(clientDecisionError({ ...edited, decision: 'edit' })).toBeNull()
  })
})
