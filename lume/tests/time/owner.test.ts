import { describe, expect, it } from 'vitest'
import { lastNOwnerDates, ownerDate, ownerDayStart } from '@/lib/time/owner'
import { countByDay } from '@/lib/overview/compute'

describe('owner timezone (America/Los_Angeles)', () => {
  it('ownerDate crosses the UTC/LA boundary', () => {
    // 01:35 UTC on the 16th is 18:35 PDT on the 15th
    expect(ownerDate('2026-10-16T01:35:00Z')).toBe('2026-10-15')
    expect(ownerDate('2026-10-16T07:00:00Z')).toBe('2026-10-16') // 00:00 PDT
    expect(ownerDate('2026-10-16T06:59:59Z')).toBe('2026-10-15')
  })

  it('ownerDayStart is local midnight, DST-aware', () => {
    expect(ownerDayStart('2026-10-15').toISOString()).toBe('2026-10-15T07:00:00.000Z') // PDT
    expect(ownerDayStart('2026-12-01').toISOString()).toBe('2026-12-01T08:00:00.000Z') // PST
    expect(ownerDayStart('2026-11-01').toISOString()).toBe('2026-11-01T07:00:00.000Z') // DST ends later that day
    expect(ownerDayStart('2026-03-08').toISOString()).toBe('2026-03-08T08:00:00.000Z') // DST starts later that day
  })

  it('lastNOwnerDates ends on the owner-zone today', () => {
    expect(lastNOwnerDates(new Date('2026-10-16T01:35:00Z'), 3)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15'])
    expect(lastNOwnerDates(new Date('2026-03-01T12:00:00Z'), 2)).toEqual(['2026-02-28', '2026-03-01'])
  })

  it('countByDay buckets by owner date, so the last bucket matches replies_today', () => {
    const now = new Date('2026-10-16T01:35:00Z') // 18:35 PDT on the 15th
    const dates = lastNOwnerDates(now, 2) // ['2026-10-14', '2026-10-15']
    const rows = [
      { created_at: '2026-10-16T01:00:00Z' }, // 18:00 PDT 15th → today
      { created_at: '2026-10-15T08:00:00Z' }, // 01:00 PDT 15th → today
      { created_at: '2026-10-15T06:30:00Z' }, // 23:30 PDT 14th → yesterday
      { created_at: '2026-10-14T06:00:00Z' }, // 23:00 PDT 13th → outside
    ]
    expect(countByDay(rows, dates, ownerDate)).toEqual([1, 2])
    // UTC bucketing disagrees: the 18:00 PDT reply lands on the 16th, the 23:30 PDT one on the 15th
    expect(countByDay(rows, ['2026-10-15', '2026-10-16'])).toEqual([2, 1])
  })
})
