import { describe, expect, it } from 'vitest'
import { addMonths, groupByDay, monthGrid, tasksKeyForMonth } from '@/lib/tasks/calendar'

describe('monthGrid', () => {
  it('is Monday-first and pads with the neighbouring months', () => {
    // November 2026 starts on a Sunday.
    const g = monthGrid('2026-11-09')
    expect(g[0][0]).toEqual({ date: '2026-10-26', inMonth: false })
    expect(g[0][6]).toEqual({ date: '2026-11-01', inMonth: true })
    expect(g.every((w) => w.length === 7)).toBe(true)
    expect(g.length).toBe(6)
    expect(g[5][6]).toEqual({ date: '2026-12-06', inMonth: false })
    expect(g.flat().filter((d) => d.inMonth)).toHaveLength(30)
  })

  it('a February starting on Monday needs four rows', () => {
    const g = monthGrid('2027-02-01')
    expect(g.length).toBe(4)
    expect(g[0][0].date).toBe('2027-02-01')
  })

  it('the SWR key spans the shown days', () => {
    expect(tasksKeyForMonth('2026-11-20')).toBe('/api/tasks?from=2026-10-26&to=2026-12-07')
  })

  it('addMonths wraps years', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-01')
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-01')
  })

  it('groups tasks by their Pacific date', () => {
    const m = groupByDay([
      { id: 'b', due_at: '2026-11-21T04:30:00Z' },
      { id: 'a', due_at: '2026-11-20T17:00:00Z' },
    ])
    expect([...m.keys()]).toEqual(['2026-11-20'])
    expect(m.get('2026-11-20')!.map((t) => t.id)).toEqual(['a', 'b'])
  })
})
