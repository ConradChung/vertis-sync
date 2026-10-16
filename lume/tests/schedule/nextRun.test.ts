import { describe, expect, it } from 'vitest'
import { nextRun, withNextRun, upcoming } from '@/lib/schedule/nextRun'

const NOW = new Date('2026-10-16T01:35:43Z')

describe('nextRun', () => {
  it('computes the next occurrence in UTC', () => {
    expect(nextRun('*/5 * * * *', NOW)).toBe('2026-10-16T01:40:00.000Z')
    expect(nextRun('0 13 * * *', NOW)).toBe('2026-10-16T13:00:00.000Z')
    expect(nextRun('0 1 * * *', NOW)).toBe('2026-10-17T01:00:00.000Z')
    expect(nextRun('0 10 * * 1', NOW)).toBe('2026-10-19T10:00:00.000Z') // next Monday
  })

  it('is strictly after now when now is exactly on a tick', () => {
    expect(nextRun('*/15 * * * *', new Date('2026-10-16T01:30:00Z'))).toBe('2026-10-16T01:45:00.000Z')
  })

  it('returns null for invalid or empty expressions', () => {
    expect(nextRun('not a cron', NOW)).toBeNull()
    expect(nextRun('61 * * * *', NOW)).toBeNull()
    expect(nextRun('', NOW)).toBeNull()
    expect(nextRun(null, NOW)).toBeNull()
  })
})

describe('withNextRun / upcoming', () => {
  const jobs = [
    { name: 'a', cron: '0 13 * * *', active: true },
    { name: 'b', cron: '*/5 * * * *', active: true },
    { name: 'c', cron: 'bogus', active: true },
    { name: 'd', cron: '0 2 * * *', active: false },
    { name: 'e', cron: '0 3 * * *', active: true },
  ]

  it('adds next_run to every job, null for invalid cron', () => {
    const out = withNextRun(jobs, NOW)
    expect(out.map((j) => j.next_run)).toEqual([
      '2026-10-16T13:00:00.000Z',
      '2026-10-16T01:40:00.000Z',
      null,
      '2026-10-16T02:00:00.000Z',
      '2026-10-16T03:00:00.000Z',
    ])
    expect(out[0]).toMatchObject({ name: 'a', cron: '0 13 * * *' })
  })

  it('upcoming picks the soonest active jobs with a next_run', () => {
    const out = upcoming(withNextRun(jobs, NOW), 3)
    expect(out.map((j) => j.name)).toEqual(['b', 'e', 'a'])
  })
})
