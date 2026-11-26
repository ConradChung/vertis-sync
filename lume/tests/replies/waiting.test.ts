import { describe, expect, it } from 'vitest'
import { FLAG_AFTER_MIN, waitingOf, waitLabel } from '@/lib/replies/waiting'

const now = new Date('2026-11-26T20:00:00Z')
const ago = (min: number, sec = 0) => new Date(now.getTime() - min * 60_000 - sec * 1000).toISOString()

describe('waitingOf (the waiting timer)', () => {
  it('counts whole minutes since the item arrived', () => {
    expect(waitingOf(ago(0, 30), now)).toEqual({ minutes: 0, label: 'just now', overdue: false })
    expect(waitingOf(ago(12, 59), now)).toMatchObject({ minutes: 12, label: '12 min' })
    expect(waitingOf(ago(59), now)).toMatchObject({ minutes: 59, label: '59 min', overdue: false })
  })

  it('is flagged once past 60 minutes: exactly 60 is not, 61 is', () => {
    expect(FLAG_AFTER_MIN).toBe(60)
    expect(waitingOf(ago(60), now)).toMatchObject({ minutes: 60, overdue: false })
    expect(waitingOf(ago(60, 59), now).overdue).toBe(false)
    expect(waitingOf(ago(61), now)).toMatchObject({ minutes: 61, label: '1 h 01 min', overdue: true })
    expect(waitingOf(ago(60 * 26 + 5), now)).toMatchObject({ label: '1 d 2 h', overdue: true })
  })

  it('reads hours with padded minutes and days with hours', () => {
    expect(waitLabel(60)).toBe('1 h 00 min')
    expect(waitLabel(125)).toBe('2 h 05 min')
    expect(waitLabel(23 * 60 + 59)).toBe('23 h 59 min')
    expect(waitLabel(24 * 60)).toBe('1 d 0 h')
    expect(waitLabel(3 * 24 * 60 + 7 * 60 + 30)).toBe('3 d 7 h')
  })

  it('a future, missing or unreadable start is zero and never flagged', () => {
    for (const since of [new Date(now.getTime() + 3_600_000).toISOString(), null, undefined, '', 'yesterday']) {
      expect(waitingOf(since, now)).toEqual({ minutes: 0, label: 'just now', overdue: false })
    }
  })

  it('accepts a millisecond clock as well as a Date', () => {
    expect(waitingOf(ago(90), now.getTime())).toMatchObject({ minutes: 90, overdue: true })
  })
})
