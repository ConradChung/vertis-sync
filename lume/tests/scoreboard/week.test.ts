import { describe, expect, it } from 'vitest'
import { weekOf } from '@/lib/scoreboard/week'

describe('weekOf (owner-zone week, Monday first)', () => {
  it('a Thursday falls in the week that started on Monday', () => {
    const w = weekOf('2026-11-26T20:00:00Z') // Thu 12:00 PT
    expect([w.start, w.end]).toEqual(['2026-11-23', '2026-11-30'])
    expect(w.label).toBe('Nov 23 – Nov 29')
    // Midnight Pacific (PST, UTC−8).
    expect(w.start_iso).toBe('2026-11-23T08:00:00.000Z')
    expect(w.end_iso).toBe('2026-11-30T08:00:00.000Z')
  })
  it('Monday 00:00 PT starts a new week; Sunday 23:59 PT is still the old one', () => {
    expect(weekOf('2026-11-30T08:00:00Z').start).toBe('2026-11-30')
    expect(weekOf('2026-11-30T07:59:00Z').start).toBe('2026-11-23')
  })
  it('uses the owner zone, not UTC: Monday 02:00 UTC is still Sunday in LA', () => {
    expect(weekOf('2026-11-23T02:00:00Z').start).toBe('2026-11-16')
  })
  it('a week that contains the DST change is still Monday to Monday', () => {
    const w = weekOf('2026-11-01T20:00:00Z') // Sunday, clocks went back that morning
    expect([w.start, w.end]).toEqual(['2026-10-26', '2026-11-02'])
    expect(w.start_iso).toBe('2026-10-26T07:00:00.000Z') // PDT
    expect(w.end_iso).toBe('2026-11-02T08:00:00.000Z') // PST
  })
  it('crosses a year end', () => {
    expect(weekOf('2027-01-01T20:00:00Z').start).toBe('2026-12-28')
  })
})
