import { describe, expect, it } from 'vitest'
import {
  campaignStatusText,
  isProblemStatus,
  itemsOf,
  lastNDates,
  mapAccount,
  mapAccounts,
  mapAnalyticsOverview,
  mapCampaigns,
  mapDaily,
  seriesOn,
} from '@/lib/adapters/instantly.map'

describe('mapCampaigns', () => {
  it('keeps problem states (status < 0) with their labels, drops id-less rows, sorts by name', () => {
    const out = mapCampaigns([
      { id: 'b', name: 'Zeta', status: 1, extra: 'x' },
      { id: 'a', name: 'Alpha', status: 2 },
      { id: 'd', name: 'Unhealthy', status: -1 },
      { id: 'e', name: 'Bouncy', status: -2 },
      { id: 'f', name: 'Suspended one', status: -99 },
      { name: 'no id', status: 1 },
      { id: 'c', name: 'Draft', status: 0 },
      'junk',
    ])
    expect(out).toEqual([
      { id: 'a', name: 'Alpha', status: 2, statusLabel: 'paused' },
      { id: 'e', name: 'Bouncy', status: -2, statusLabel: 'bounce_protect' },
      { id: 'c', name: 'Draft', status: 0, statusLabel: 'draft' },
      { id: 'f', name: 'Suspended one', status: -99, statusLabel: 'suspended' },
      { id: 'd', name: 'Unhealthy', status: -1, statusLabel: 'accounts_unhealthy' },
      { id: 'b', name: 'Zeta', status: 1, statusLabel: 'active' },
    ])
  })

  it('names problem states for the status badge', () => {
    expect(['suspended', 'accounts_unhealthy', 'bounce_protect', '-7', 'running_subsequences'].map(campaignStatusText)).toEqual([
      'Suspended',
      'Accounts unhealthy',
      'Bounce protect',
      'Problem (-7)',
      'running subsequences',
    ])
    expect(['suspended', 'accounts_unhealthy', 'bounce_protect', '-7'].every(isProblemStatus)).toBe(true)
    expect(['active', 'paused', 'draft'].some(isProblemStatus)).toBe(false)
  })
})

describe('mapAnalyticsOverview', () => {
  it('reads emails_sent_count / reply_count / total_opportunities', () => {
    expect(
      mapAnalyticsOverview({ emails_sent_count: 400, reply_count: 10, bounced_count: 3, total_opportunities: 2, total_opportunity_value: 5000 })
    ).toEqual({ sent: 400, replies: 10, bounced: 3, opportunities: 2, opportunity_value: 5000, reply_rate: 2.5 })
  })

  it('falls back to contacted_count, tolerates a one-element array and empty bodies', () => {
    expect(mapAnalyticsOverview([{ contacted_count: '50', reply_count: 1 }])).toMatchObject({ sent: 50, replies: 1, reply_rate: 2 })
    expect(mapAnalyticsOverview(null)).toEqual({ sent: 0, replies: 0, bounced: 0, opportunities: 0, opportunity_value: null, reply_rate: null })
  })
})

describe('mapDaily / seriesOn / lastNDates', () => {
  const daily = mapDaily([
    { date: '2026-10-15', sent: 100, replies: 2, opportunities: 1 },
    { date: '2026-10-13T00:00:00Z', sent: 80, unique_replies: 1 },
    { nodate: true },
  ])

  it('normalises dates and sorts ascending', () => {
    expect(daily).toEqual([
      { date: '2026-10-13', sent: 80, replies: 1, opportunities: 0 },
      { date: '2026-10-15', sent: 100, replies: 2, opportunities: 1 },
    ])
    expect(mapDaily({ items: [{ date: '2026-10-01', sent: 1 }] })).toHaveLength(1)
    expect(mapDaily('nope')).toEqual([])
  })

  it('lastNDates is UTC and ascending', () => {
    expect(lastNDates(new Date('2026-10-16T01:00:00Z'), 3)).toEqual(['2026-10-14', '2026-10-15', '2026-10-16'])
  })

  it('seriesOn aligns to dates with zeros and sums several series', () => {
    const dates = ['2026-10-13', '2026-10-14', '2026-10-15']
    expect(seriesOn(dates, 'sent', daily)).toEqual([80, 0, 100])
    expect(seriesOn(dates, 'sent', daily, [{ date: '2026-10-14', sent: 5, replies: 0, opportunities: 0 }])).toEqual([80, 5, 100])
  })

  it('itemsOf accepts arrays, {items}, {data}', () => {
    expect(itemsOf([1])).toEqual([1])
    expect(itemsOf({ items: [2] })).toEqual([2])
    expect(itemsOf({ data: [3] })).toEqual([3])
    expect(itemsOf({})).toEqual([])
  })
})

describe('mapAccount', () => {
  it('maps numeric codes to labels and keeps only the five fields', () => {
    const a = mapAccount({
      email: 'a@x.com',
      status: 1,
      warmup_status: 1,
      stat_warmup_score: 92,
      daily_limit: 50,
      provider_code: 2,
      token: 'secret-ish',
    })
    expect(a).toEqual({ email: 'a@x.com', status: 'active', warmup_status: 'active', warmup_score: 92, daily_limit: 50 })
  })

  it('handles string statuses, nested warmup score, unknown codes and missing fields', () => {
    expect(mapAccount({ email: 'b@x.com', status: 'Paused', warmup_status: -1, warmup: { score: 40 } })).toEqual({
      email: 'b@x.com',
      status: 'paused',
      warmup_status: 'banned',
      warmup_score: 40,
      daily_limit: null,
    })
    expect(mapAccount({ email: 'c@x.com', status: 9 })).toMatchObject({ status: '9', warmup_status: 'unknown', warmup_score: null })
    expect(mapAccount({ status: 1 })).toBeNull()
    expect(mapAccount(null)).toBeNull()
  })

  it('mapAccounts drops invalid rows and sorts by email', () => {
    expect(mapAccounts([{ email: 'z@x.com' }, {}, { email: 'a@x.com' }]).map((a) => a.email)).toEqual(['a@x.com', 'z@x.com'])
  })
})

import { lumeCampaignStatus, mapCampaignDetails, mapCampaignSequence } from '@/lib/adapters/instantly.map'

describe('mapCampaignDetails', () => {
  it('adds daily_limit and the account count', () => {
    expect(
      mapCampaignDetails([
        { id: 'c1', name: 'A', status: 1, daily_limit: 50, email_list: ['a@x', 'b@x'] },
        { id: 'c2', name: 'B', status: 2 },
        { id: 'sick', name: 'D', status: -1 },
      ])
    ).toEqual([
      { id: 'c1', name: 'A', status: 1, statusLabel: 'active', dailyLimit: 50, accounts: 2 },
      { id: 'c2', name: 'B', status: 2, statusLabel: 'paused', dailyLimit: null, accounts: 0 },
      { id: 'sick', name: 'D', status: -1, statusLabel: 'accounts_unhealthy', dailyLimit: null, accounts: 0 },
    ])
  })

  it('maps statuses onto the lume vocabulary', () => {
    expect([0, 1, 2, 3, 4, 9, -99, -1, -2, -5].map(lumeCampaignStatus)).toEqual(['draft', 'active', 'paused', 'completed', 'active', 'unknown', 'suspended', 'accounts_unhealthy', 'bounce_protect', 'unknown'])
  })
})

describe('mapCampaignSequence', () => {
  it('takes the first steps of the first sequence, variant A, as plain text', () => {
    const steps = mapCampaignSequence({
      sequences: [
        {
          steps: [
            { delay: 0, variants: [{ subject: 'Hi {{firstName}}', body: '<p>Hello&nbsp;there</p><p>Bye</p>' }, { subject: 'B' }] },
            { delay: 3, variants: [{ subject: '', body: 'Bump' }] },
            { delay: 4, variants: [] },
            { delay: 5, variants: [{ subject: 'four' }] },
          ],
        },
      ],
    })
    expect(steps).toEqual([
      { step: 1, delayDays: 0, subject: 'Hi {{firstName}}', body: 'Hello there\nBye', variants: 2 },
      { step: 2, delayDays: 3, subject: '', body: 'Bump', variants: 1 },
      { step: 3, delayDays: 4, subject: '', body: '', variants: 0 },
    ])
  })

  it('[] for anything else', () => {
    expect(mapCampaignSequence(null)).toEqual([])
    expect(mapCampaignSequence({ sequences: [] })).toEqual([])
  })
})
