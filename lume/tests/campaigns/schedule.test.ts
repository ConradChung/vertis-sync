import { describe, expect, it } from 'vitest'
import { formatDays, formatGap, parseSchedule, scheduleState, zoneLabel } from '@/lib/campaigns/schedule'

const raw = (over: Record<string, unknown> = {}) => ({
  schedules: [
    {
      name: 'New schedule',
      timing: { from: '05:00', to: '21:00' },
      days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
      timezone: 'Europe/Isle_of_Man',
      ...over,
    },
  ],
})

describe('parseSchedule', () => {
  it('reads the first schedule', () => {
    expect(parseSchedule(raw())).toEqual({ timezone: 'Europe/Isle_of_Man', from: '05:00', to: '21:00', days: [1, 2, 3, 4, 5] })
  })
  it('rejects missing or malformed schedules', () => {
    expect(parseSchedule(null)).toBeNull()
    expect(parseSchedule({ schedules: [] })).toBeNull()
    expect(parseSchedule(raw({ timing: { from: '5pm', to: '21:00' } }))).toBeNull()
    expect(parseSchedule(raw({ timezone: '' }))).toBeNull()
  })
})

describe('labels', () => {
  it('formats days and zones', () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe('Mon–Fri')
    expect(formatDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day')
    expect(formatDays([1, 3])).toBe('Mon, Wed')
    expect(zoneLabel('Europe/Isle_of_Man')).toBe('UK')
    expect(zoneLabel('Asia/Dubai')).toBe('Dubai')
    expect(formatGap(200 * 60_000)).toBe('3h 20m')
  })
})

describe('scheduleState', () => {
  const uk = parseSchedule(raw())!
  it('is in the window on a weekday afternoon (UK, GMT in November)', () => {
    // Thu 2026-11-12 14:00 GMT
    const st = scheduleState(uk, new Date('2026-11-12T14:00:00Z'))!
    expect(st.inWindow).toBe(true)
    expect(st.window!.end.toISOString()).toBe('2026-11-12T21:00:00.000Z')
    expect(st.ownerWindow).toBe('21:00–13:00')
  })
  it('points at Monday when it is the weekend', () => {
    // Sat 2026-11-14 12:00 GMT → Mon 05:00 GMT
    const st = scheduleState(uk, new Date('2026-11-14T12:00:00Z'))!
    expect(st.inWindow).toBe(false)
    expect(st.window!.start.toISOString()).toBe('2026-11-16T05:00:00.000Z')
  })
  it('handles DST zones (Chicago, CST in November)', () => {
    const chi = parseSchedule(raw({ timezone: 'America/Chicago' }))!
    // Thu 2026-11-12 10:00 UTC = 04:00 CST → opens 05:00 CST = 11:00 UTC
    const st = scheduleState(chi, new Date('2026-11-12T10:00:00Z'))!
    expect(st.inWindow).toBe(false)
    expect(st.window!.start.toISOString()).toBe('2026-11-12T11:00:00.000Z')
  })
  it('returns null for a zone the runtime does not know', () => {
    expect(scheduleState({ ...uk, timezone: 'Mars/Olympus' })).toBeNull()
  })
  it('has no window when no day is enabled', () => {
    expect(scheduleState({ ...uk, days: [] }, new Date())!.window).toBeNull()
  })
})
