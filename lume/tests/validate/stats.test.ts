import { describe, expect, it } from 'vitest'
import { historyRow, invalidRate, sourceLabel, validationStats } from '@/lib/validate/stats'

// Live job 16f26ffc's grouped counts.
const LIVE = [
  { status: 'valid', reason: 'Accepted', n: 4562 },
  { status: 'error', reason: 'MX Error', n: 185 },
  { status: 'invalid', reason: 'Catch-All', n: 181 },
  { status: 'invalid', reason: 'Greylisted', n: 82 },
  { status: 'invalid', reason: 'No MX', n: 81 },
  { status: 'error', reason: 'Timeout', n: 79 },
  { status: 'invalid', reason: 'Rejected', n: 44 },
  { status: 'error', reason: 'SPAM Block', n: 36 },
  { status: 'no_email', reason: null, n: 17 },
  { status: 'invalid', reason: 'Disposable', n: 3 },
  { status: 'pending', reason: null, n: 50 },
]

describe('validationStats', () => {
  it('invalid rate = invalid ÷ (valid + invalid); errors and no-email shown apart, not in the rate; pending left out', () => {
    const s = validationStats(LIVE)
    expect([s.valid, s.invalid, s.error, s.no_email, s.pending]).toEqual([4562, 391, 300, 17, 50])
    expect(s.decided).toBe(4953)
    expect(s.invalid_rate).toBe(7.9)
    expect(s.error_rate).toBe(5.7) // of everything checked (valid + invalid + error)
  })
  it('breakdown by MailTester reason, largest first within valid / invalid / error / no email, with % of checked rows', () => {
    const s = validationStats(LIVE)
    expect(s.breakdown.map((b) => [b.status, b.label, b.n])).toEqual([
      ['valid', 'Accepted', 4562],
      ['invalid', 'Catch-All', 181],
      ['invalid', 'Greylisted', 82],
      ['invalid', 'No MX', 81],
      ['invalid', 'Rejected', 44],
      ['invalid', 'Disposable', 3],
      ['error', 'MX Error', 185],
      ['error', 'Timeout', 79],
      ['error', 'SPAM Block', 36],
      ['no_email', 'No email', 17],
    ])
    expect(s.breakdown[1].pct).toBe(3.4) // 181 of 5,270
  })
  it('nothing decided yet → null rates', () => {
    expect(validationStats([{ status: 'pending', reason: null, n: 10 }]).invalid_rate).toBeNull()
    expect(invalidRate(0, 0)).toBeNull()
    expect(invalidRate(3, 1)).toBe(25)
  })
})

describe('history', () => {
  it('source: the ingest sender, else the job source in words', () => {
    expect(sourceLabel({ sender_name: 'Leadsfriday (Apollo link)', source: 'telegram' })).toBe('Leadsfriday (Apollo link)')
    expect(sourceLabel({ sender_name: null, source: 'csv' })).toBe('CSV import')
    expect(sourceLabel({ sender_name: null, source: null })).toBe('—')
  })
  it('one row: title, source, total, valid / invalid / error % and the top invalid reason', () => {
    const r = historyRow({ id: 'j', filename: 'f.csv', source: 'telegram', total_rows: 5385, created_at: '2026-08-22T09:51:03Z', finished_at: null, sender_name: 'nrthstar', ingest_filename: 'f.csv', valid: 3279, invalid: 1843, error: 263, no_email: 1903, pending: 0, top_invalid_reason: 'Catch-All', top_invalid_count: 1546 })
    expect(r).toMatchObject({ title: '5,385 leads · 22 Aug', source: 'nrthstar', total: 5385, valid_pct: 60.9, invalid_rate: 36, error_pct: 4.9, top_invalid: 'Catch-All (1,546)' })
  })
})
