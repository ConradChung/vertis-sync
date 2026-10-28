import { describe, expect, it } from 'vitest'
import {
  leadMatches,
  mapLead,
  mapUsage,
  parseLeadQuery,
  protectedReason,
  summarizeLeads,
  upstreamFilter,
  type CampaignLead,
} from '@/lib/adapters/instantlyLeads.map'

const NOW = new Date('2026-10-27T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const lead = (over: Partial<CampaignLead> = {}): CampaignLead => ({
  id: 'l1',
  email: 'a@x.com',
  name: 'Ann Lee',
  company: 'X',
  status: 3,
  status_label: 'completed',
  last_contact_at: daysAgo(20),
  last_reply_at: null,
  reply_count: 0,
  interest: null,
  interest_label: null,
  ...over,
})

describe('parseLeadQuery', () => {
  it('accepts the named states and no_reply_after_days:N', () => {
    expect(parseLeadQuery('finished_no_reply')).toEqual({ state: 'finished_no_reply' })
    expect(parseLeadQuery('replied')).toEqual({ state: 'replied' })
    expect(parseLeadQuery('bounced')).toEqual({ state: 'bounced' })
    expect(parseLeadQuery('contacted')).toEqual({ state: 'contacted' })
    expect(parseLeadQuery('interested')).toEqual({ state: 'interested' })
    expect(parseLeadQuery('no_reply_after_days:14')).toEqual({ state: 'no_reply_after_days', days: 14 })
  })
  it('refuses unknown states and bad day counts', () => {
    expect(parseLeadQuery('everything')).toBeNull()
    expect(parseLeadQuery('no_reply_after_days')).toBeNull()
    expect(parseLeadQuery('no_reply_after_days:0')).toBeNull()
    expect(parseLeadQuery('no_reply_after_days:abc')).toBeNull()
    expect(parseLeadQuery('no_reply_after_days:9999')).toBeNull()
  })
})

describe('upstreamFilter', () => {
  it('maps each state to its Instantly filter', () => {
    expect(upstreamFilter({ state: 'finished_no_reply' })).toBe('FILTER_VAL_COMPLETED_NO_REPLY')
    expect(upstreamFilter({ state: 'replied' })).toBe('FILTER_VAL_REPLIED')
    expect(upstreamFilter({ state: 'bounced' })).toBe('FILTER_VAL_BOUNCED')
    expect(upstreamFilter({ state: 'contacted' })).toBe('FILTER_VAL_CONTACTED')
    expect(upstreamFilter({ state: 'interested' })).toBe('FILTER_LEAD_INTERESTED')
    expect(upstreamFilter({ state: 'no_reply_after_days', days: 7 })).toBe('FILTER_VAL_CONTACTED')
  })
})

describe('mapLead', () => {
  it('keeps the fields the agent needs', () => {
    expect(
      mapLead({
        id: 'abc',
        email: 'Ann@X.com',
        first_name: 'Ann',
        last_name: 'Lee',
        company_name: 'X Inc',
        status: -1,
        timestamp_last_contact: '2026-10-01T00:00:00Z',
        timestamp_last_reply: null,
        email_reply_count: 0,
        lt_interest_status: 1,
        payload: { country: 'US' },
      })
    ).toEqual({
      id: 'abc',
      email: 'ann@x.com',
      name: 'Ann Lee',
      company: 'X Inc',
      status: -1,
      status_label: 'bounced',
      last_contact_at: '2026-10-01T00:00:00Z',
      last_reply_at: null,
      reply_count: 0,
      interest: 1,
      interest_label: 'interested',
    })
  })
  it('drops rows without an id', () => {
    expect(mapLead({ email: 'a@b.c' })).toBeNull()
    expect(mapLead(null)).toBeNull()
  })
})

describe('protectedReason', () => {
  it('protects replied and interested leads', () => {
    expect(protectedReason(lead())).toBeNull()
    expect(protectedReason(lead({ reply_count: 1 }))).toBe('replied')
    expect(protectedReason(lead({ last_reply_at: daysAgo(3) }))).toBe('replied')
    expect(protectedReason(lead({ interest: 1 }))).toBe('interested')
    expect(protectedReason(lead({ interest: 2 }))).toBe('interested')
    expect(protectedReason(lead({ interest: 4 }))).toBe('interested')
    // not interested / wrong person are not protected by interest alone
    expect(protectedReason(lead({ interest: -1 }))).toBeNull()
  })
})

describe('leadMatches', () => {
  it('finished_no_reply needs a completed sequence; days = last contact at least N days ago', () => {
    expect(leadMatches(lead(), { state: 'finished_no_reply' }, NOW)).toBe(true)
    expect(leadMatches(lead({ status: -1 }), { state: 'finished_no_reply' }, NOW)).toBe(false)
    expect(leadMatches(lead(), { state: 'finished_no_reply', days: 14 }, NOW)).toBe(true)
    expect(leadMatches(lead({ last_contact_at: daysAgo(10) }), { state: 'finished_no_reply', days: 14 }, NOW)).toBe(false)
    expect(leadMatches(lead({ last_contact_at: null }), { state: 'finished_no_reply', days: 14 }, NOW)).toBe(false)
  })
  it('no_reply_after_days: contacted, never replied, not bounced, last contact old enough', () => {
    const q = { state: 'no_reply_after_days' as const, days: 7 }
    expect(leadMatches(lead({ status: 1, last_contact_at: daysAgo(8) }), q, NOW)).toBe(true)
    expect(leadMatches(lead({ status: 1, last_contact_at: daysAgo(3) }), q, NOW)).toBe(false)
    expect(leadMatches(lead({ status: 1, reply_count: 1 }), q, NOW)).toBe(false)
    expect(leadMatches(lead({ status: -1 }), q, NOW)).toBe(false)
  })
  it('no_reply_after_days excludes a lead with only a reply timestamp', () => {
    expect(leadMatches(lead({ status: 1, last_contact_at: daysAgo(8), last_reply_at: daysAgo(8) }), { state: 'no_reply_after_days', days: 7 }, NOW)).toBe(false)
  })
  it('interested-but-unreplied leads are not "finished no reply"', () => {
    expect(leadMatches(lead({ interest: 1 }), { state: 'finished_no_reply' }, NOW)).toBe(false)
  })
  it('trusts the upstream filter for the other states', () => {
    expect(leadMatches(lead({ reply_count: 2 }), { state: 'replied' }, NOW)).toBe(true)
    expect(leadMatches(lead({ status: -1 }), { state: 'bounced' }, NOW)).toBe(true)
  })
})

describe('summarizeLeads', () => {
  it('counts by status, replied and interested', () => {
    expect(summarizeLeads([lead(), lead({ status: -1, status_label: 'bounced' }), lead({ reply_count: 1, interest: 1 })])).toEqual({
      total: 3,
      by_status: { completed: 2, bounced: 1 },
      replied: 1,
      interested: 1,
    })
  })
})

describe('mapUsage', () => {
  it('reads current / limit and computes headroom', () => {
    expect(
      mapUsage({
        subscriptions: { outreach: { plan_name: 'Growth', current_lead_count: 950, total_lead_limit: 1000, base_lead_limit: 1000, addons_qty: 0 } },
      })
    ).toEqual({ plan_name: 'Growth', current: 950, limit: 1000, base_limit: 1000, addons: 0, headroom: 50, used_pct: 95 })
  })
  it('null when the outreach plan is missing', () => {
    expect(mapUsage({ subscriptions: {} })).toBeNull()
    expect(mapUsage(null)).toBeNull()
  })
})
