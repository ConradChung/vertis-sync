import { describe, expect, it } from 'vitest'
import { accountHealth, campaignHealth, countByCampaign, countByDay, countdown, timeAgo } from '@/lib/overview/compute'

describe('campaignHealth', () => {
  it('red at 5+ bounces in 24 h, regardless of reply rate', () => {
    expect(campaignHealth({ bounces24h: 5, replyRate: 6 })).toMatchObject({ level: 'red', reason: expect.stringContaining('5 bounces') })
    expect(campaignHealth({ bounces24h: 12, replyRate: null }).level).toBe('red')
  })

  it('amber under 1 % reply rate', () => {
    const h = campaignHealth({ bounces24h: 4, replyRate: 0.6 })
    expect(h.level).toBe('amber')
    expect(h.reason).toBe('Reply rate 0.6% is under 1%')
    expect(campaignHealth({ bounces24h: 0, replyRate: 0 }).level).toBe('amber')
  })

  it('green at or above 1 %', () => {
    expect(campaignHealth({ bounces24h: 0, replyRate: 1 })).toEqual({ level: 'green', reason: 'Reply rate 1.0% · 0 bounces in 24 h' })
    expect(campaignHealth({ bounces24h: 1, replyRate: 14.2 }).reason).toBe('Reply rate 14% · 1 bounce in 24 h')
  })

  it('idle when there is no reply rate', () => {
    expect(campaignHealth({ bounces24h: 0, replyRate: null })).toEqual({ level: 'idle', reason: 'No sends yet' })
    expect(campaignHealth({ bounces24h: 0, replyRate: null, idleReason: 'Gmail not connected' }).reason).toBe('Gmail not connected')
  })
})

describe('countByDay / countByCampaign', () => {
  it('buckets by UTC date, ignores rows outside the window', () => {
    const dates = ['2026-10-14', '2026-10-15', '2026-10-16']
    const rows = [
      { created_at: '2026-10-14T23:59:00+00:00' },
      { created_at: '2026-10-15T20:00:00-07:00' }, // = 10-16 03:00 UTC
      { created_at: '2026-10-16T01:00:00.123+00:00' },
      { created_at: '2026-10-01T00:00:00+00:00' },
    ]
    expect(countByDay(rows, dates)).toEqual([1, 0, 2])
  })

  it('counts per campaign', () => {
    const m = countByCampaign([{ campaign_id: 'a' }, { campaign_id: 'a' }, { campaign_id: null }, { campaign_id: 'b' }])
    expect([...m]).toEqual([['a', 2], ['b', 1]])
  })
})

describe('timeAgo / countdown', () => {
  const now = Date.parse('2026-10-16T01:00:00Z')
  it('timeAgo', () => {
    expect(timeAgo('2026-10-16T00:59:55Z', now)).toBe('now')
    expect(timeAgo('2026-10-16T00:59:18Z', now)).toBe('42s ago')
    expect(timeAgo('2026-10-16T00:55:00Z', now)).toBe('5m ago')
    expect(timeAgo('2026-10-15T22:00:00Z', now)).toBe('3h ago')
    expect(timeAgo('2026-10-14T00:00:00Z', now)).toBe('2d ago')
  })
  it('countdown', () => {
    expect(countdown('2026-10-16T01:08:42Z', now)).toBe('in 8m 42s')
    expect(countdown('2026-10-16T02:18:00Z', now)).toBe('in 1h 18m')
    expect(countdown('2026-10-18T04:00:00Z', now)).toBe('in 2d 3h')
    expect(countdown('2026-10-16T01:00:09Z', now)).toBe('in 9s')
    expect(countdown('2026-10-16T00:00:00Z', now)).toBe('due')
    expect(countdown(null, now)).toBe('—')
  })
})

describe('accountHealth', () => {
  it('red on account errors and burned warmup', () => {
    expect(accountHealth({ status: 'sending_error', warmup_status: 'active', warmup_score: 95 }).level).toBe('red')
    expect(accountHealth({ status: 'active', warmup_status: 'banned', warmup_score: 95 })).toEqual({ level: 'red', reason: 'warmup banned' })
  })
  it('amber when paused or cool', () => {
    expect(accountHealth({ status: 'paused', warmup_status: 'active', warmup_score: 95 }).level).toBe('amber')
    expect(accountHealth({ status: 'active', warmup_status: 'paused', warmup_score: 95 }).level).toBe('amber')
    expect(accountHealth({ status: 'active', warmup_status: 'active', warmup_score: 40 })).toEqual({ level: 'amber', reason: 'warmup at 40%' })
  })
  it('green when active and warm', () => {
    expect(accountHealth({ status: 'active', warmup_status: 'active', warmup_score: 92 })).toEqual({ level: 'green', reason: 'warm (92%)' })
    expect(accountHealth({ status: 'active', warmup_status: 'active', warmup_score: null }).level).toBe('green')
  })
})
