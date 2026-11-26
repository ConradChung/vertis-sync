import { describe, expect, it } from 'vitest'
import { addDays, checkinsDue, daysBetween, isDate, pilotCheckins, pilotDay, shortDate, type PilotFields } from '@/lib/crm/pilot'

const deal = (over: Partial<PilotFields & { id: string }> = {}) => ({
  id: 'd1',
  stage: 'Pilot',
  pilot_start_date: '2026-11-01',
  pilot_checkin_10_done_at: null,
  pilot_checkin_25_done_at: null,
  referral_asked_at: null,
  ...over,
})

describe('pilot dates', () => {
  it('adds days across month and year ends, and rejects dates that do not exist', () => {
    expect(addDays('2026-11-25', 10)).toBe('2026-12-05')
    expect(addDays('2026-12-20', 25)).toBe('2027-01-14')
    expect(daysBetween('2026-11-01', '2026-11-11')).toBe(10)
    expect(daysBetween('2026-11-11', '2026-11-01')).toBe(-10)
    expect(isDate('2026-11-30')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-01', '11/20/2026', '', null, 20261120]) expect(isDate(bad)).toBe(false)
    expect(shortDate('2026-11-30')).toBe('Nov 30')
  })
  it('day 0 is the start date', () => {
    expect(pilotDay('2026-11-01', '2026-11-01')).toBe(0)
    expect(pilotDay('2026-11-01', '2026-11-26')).toBe(25)
    expect(pilotDay(null, '2026-11-26')).toBeNull()
  })
})

describe('pilotCheckins', () => {
  it('are due 10 and 25 days after the start date', () => {
    expect(pilotCheckins(deal(), '2026-11-05').map((c) => [c.day, c.due_date, c.state])).toEqual([
      [10, '2026-11-11', 'upcoming'],
      [25, '2026-11-26', 'upcoming'],
    ])
  })
  it('a check-in is due on its day and stays due, counting the days late, until ticked', () => {
    const on = pilotCheckins(deal(), '2026-11-11')
    expect(on[0]).toMatchObject({ day: 10, state: 'due', days_late: 0 })
    expect(pilotCheckins(deal(), '2026-11-10')[0].state).toBe('upcoming')
    const late = pilotCheckins(deal(), '2026-11-28')
    expect(late.map((c) => [c.state, c.days_late])).toEqual([['due', 17], ['due', 2]])
  })
  it('a ticked check-in is done whatever the date', () => {
    const c = pilotCheckins(deal({ pilot_checkin_10_done_at: '2026-11-12T18:00:00Z' }), '2026-11-28')
    expect(c[0]).toMatchObject({ state: 'done', days_late: 0, done_at: '2026-11-12T18:00:00Z' })
    expect(c[1].state).toBe('due')
  })
  it('no start date, no check-ins', () => {
    expect(pilotCheckins(deal({ pilot_start_date: null }), '2026-11-28')).toEqual([])
    expect(pilotCheckins(deal({ pilot_start_date: 'soon' }), '2026-11-28')).toEqual([])
  })
})

describe('checkinsDue (the Today queue)', () => {
  it('lists unticked check-ins whose day has come, most overdue first', () => {
    const due = checkinsDue(
      [
        deal({ id: 'a', pilot_start_date: '2026-11-16' }), // day 10 due today
        deal({ id: 'b', pilot_start_date: '2026-11-01' }), // day 10 15 d late, day 25 today
        deal({ id: 'c', pilot_start_date: '2026-11-20' }), // nothing yet
      ],
      '2026-11-26'
    )
    expect(due.map((d) => [d.deal.id, d.day, d.days_late])).toEqual([
      ['b', 10, 15],
      ['a', 10, 0],
      ['b', 25, 0],
    ])
  })
  it('skips ticked check-ins, deals outside Pilot and deals without a start date', () => {
    const due = checkinsDue(
      [
        deal({ id: 'done', pilot_checkin_10_done_at: '2026-11-11T00:00:00Z', pilot_checkin_25_done_at: '2026-11-26T00:00:00Z' }),
        deal({ id: 'paid', stage: 'Paid' }),
        deal({ id: 'lost', stage: 'Lost' }),
        deal({ id: 'nodate', pilot_start_date: null }),
      ],
      '2026-12-30'
    )
    expect(due).toEqual([])
  })
})
