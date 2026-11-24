import { describe, expect, it } from 'vitest'
import { fitsCap, isDue, monthToDate, parseHiringConfig, parseManualBody } from '@/lib/hiring/config'
import { monthStartIso } from '@/lib/hiring/engine'

describe('parseHiringConfig', () => {
  it('the launch value', () => {
    const c = parseHiringConfig({ dry_run: true, lanes: { hiring: true, new_manager: false, expansion: false }, monthly_cap_usd: 40, run_cap_usd: { hiring: 2, new_manager: 3, expansion: 1 }, regions: ['United States', 'Canada'] })
    expect(c).toEqual({ dry_run: true, lanes: { hiring: true, new_manager: false, expansion: false }, monthly_cap_usd: 40, run_cap_usd: { hiring: 2, new_manager: 3, expansion: 1 }, regions: ['United States', 'Canada'] })
  })
  it('malformed → dry run, every lane off, default caps', () => {
    for (const v of [null, 'x', 42, [], { lanes: 'all', dry_run: 'false' }]) {
      const c = parseHiringConfig(v)
      expect(c.dry_run).toBe(true)
      expect(c.lanes).toEqual({ hiring: false, new_manager: false, expansion: false })
      expect(c.monthly_cap_usd).toBe(40)
    }
  })
  it('caps are clamped; unknown regions dropped', () => {
    const c = parseHiringConfig({ dry_run: false, monthly_cap_usd: 500, run_cap_usd: { hiring: 99, expansion: -1 }, regions: ['Mexico'] })
    expect(c.dry_run).toBe(false)
    expect(c.monthly_cap_usd).toBe(40)
    expect(c.run_cap_usd).toEqual({ hiring: 5, new_manager: 3, expansion: 1 })
    expect(c.regions).toEqual(['United States', 'Canada'])
  })
})

describe('caps and schedule', () => {
  it('fitsCap: month-to-date + run cap must stay within the monthly cap', () => {
    expect(fitsCap(38, 2, 40)).toBe(true)
    expect(fitsCap(38.01, 2, 40)).toBe(false)
    expect(fitsCap(0, 0.5, 40)).toBe(true)
  })
  it('monthToDate counts reserved + settled, not released', () => {
    expect(monthToDate([{ usd: 2, status: 'reserved' }, { usd: '0.4', status: 'settled' }, { usd: 3, status: 'released' }])).toBe(2.4)
  })
  it('isDue: hiring daily, new_manager weekly', () => {
    const now = new Date('2026-11-23T20:00:00Z')
    expect(isDue('hiring', null, now)).toBe(true)
    expect(isDue('hiring', '2026-11-22T20:05:00Z', now)).toBe(true) // within the 10 min slack
    expect(isDue('hiring', '2026-11-23T08:00:00Z', now)).toBe(false)
    expect(isDue('new_manager', '2026-11-20T20:00:00Z', now)).toBe(false)
    expect(isDue('new_manager', '2026-11-16T20:00:00Z', now)).toBe(true)
  })
  it('the month starts at midnight PT', () => {
    expect(monthStartIso(new Date('2026-11-23T20:00:00Z'))).toBe('2026-11-01T07:00:00.000Z')
    expect(monthStartIso(new Date('2026-12-01T05:00:00Z'))).toBe('2026-11-01T07:00:00.000Z') // still Nov 30 in PT
  })
})

describe('parseManualBody', () => {
  it('no force → scheduled tick', () => {
    expect(parseManualBody(null)).toBeNull()
    expect(parseManualBody({ lane: 'hiring' })).toBeNull()
  })
  it('the first live run', () => {
    expect(parseManualBody({ lane: 'hiring', run_cap_usd: 0.5, max_items: 25, force: true })).toEqual({ lane: 'hiring', run_cap_usd: 0.5, max_items: 25 })
  })
  it('refuses unknown lanes and bad numbers', () => {
    expect(parseManualBody({ lane: 'nope', force: true })).toHaveProperty('error')
    expect(parseManualBody({ lane: 'hiring', run_cap_usd: 50, force: true })).toHaveProperty('error')
    expect(parseManualBody({ lane: 'hiring', max_items: 2.5, force: true })).toHaveProperty('error')
  })
})
