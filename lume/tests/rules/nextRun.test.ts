import { describe, expect, it } from 'vitest'
import { describeCron, isValidRuleCron, nextRun, RULE_MIN_INTERVAL_MINUTES } from '@/lib/rules/nextRun'

// Friday 2026-10-16 01:35 UTC = Thursday 2026-10-15 18:35 in Los Angeles (PDT, UTC-7).
const NOW = new Date('2026-10-16T01:35:43Z')

describe('nextRun (owner timezone)', () => {
  it("evaluates '0 8 * * 1-5' at 08:00 Los Angeles time on the next weekday", () => {
    // Thursday evening in LA → Friday 08:00 PDT = 15:00 UTC.
    expect(nextRun('0 8 * * 1-5', NOW)).toBe('2026-10-16T15:00:00.000Z')
  })

  it('skips the weekend', () => {
    // Friday 2026-10-16 09:00 PDT → Monday 2026-10-19 08:00 PDT.
    expect(nextRun('0 8 * * 1-5', new Date('2026-10-16T16:00:00Z'))).toBe('2026-10-19T15:00:00.000Z')
  })

  it('follows the DST change (PST after 2026-11-01)', () => {
    // Monday 2026-11-02 08:00 PST = 16:00 UTC.
    expect(nextRun('0 8 * * 1-5', new Date('2026-11-01T20:00:00Z'))).toBe('2026-11-02T16:00:00.000Z')
  })

  it('honours an explicit tz', () => {
    expect(nextRun('0 8 * * 1-5', NOW, 'UTC')).toBe('2026-10-16T08:00:00.000Z')
  })

  it('is strictly after now', () => {
    expect(nextRun('0 8 * * *', new Date('2026-10-16T15:00:00Z'))).toBe('2026-10-17T15:00:00.000Z')
  })

  it('null for empty or invalid expressions', () => {
    expect(nextRun('', NOW)).toBeNull()
    expect(nextRun(null, NOW)).toBeNull()
    expect(nextRun('nope', NOW)).toBeNull()
    expect(nextRun('61 * * * *', NOW)).toBeNull()
  })
})

describe('isValidRuleCron', () => {
  it('accepts five-field expressions', () => {
    expect(isValidRuleCron('0 8 * * 1-5')).toBe(true)
    expect(isValidRuleCron('30 9,15 * * *')).toBe(true)
  })

  it('rejects seconds fields, garbage, and anything firing more often than the tick', () => {
    expect(isValidRuleCron('0 0 8 * * 1-5')).toBe(false)
    expect(isValidRuleCron('bogus')).toBe(false)
    expect(isValidRuleCron('* * * * *')).toBe(false)
    expect(isValidRuleCron('*/5 * * * *')).toBe(false)
    expect(isValidRuleCron(`*/${RULE_MIN_INTERVAL_MINUTES} * * * *`)).toBe(true)
  })
})

describe('describeCron', () => {
  it('names the zone', () => {
    expect(describeCron('0 8 * * 1-5')).toContain('America/Los_Angeles')
  })
})
