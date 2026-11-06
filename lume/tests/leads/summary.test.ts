import { describe, expect, it } from 'vitest'
import { metricLabel, shapeSummary, SummaryInput } from '@/lib/leads/summary'

describe('lead set summary', () => {
  it('names the RPC columns back: group values by column, count, and each metric as op(column)', () => {
    const out = shapeSummary(
      { group_count: 2, total_rows: 3, groups: [{ g1: 'Ann', n: 2, m1: 15, m2: 1 }], other: { groups: 1, rows: 1 } },
      ['author.name'],
      [{ op: 'sum', column: 'stats.totalReactions' }, { op: 'count_distinct', column: 'author.profileUrl' }]
    )
    expect(out).toEqual({
      total_rows: 3,
      group_count: 2,
      groups: [{ 'author.name': 'Ann', count: 2, 'sum(stats.totalReactions)': 15, 'count_distinct(author.profileUrl)': 1 }],
      other: { groups: 1, rows: 1 },
    })
    expect(metricLabel({ op: 'avg', column: 'x' })).toBe('avg(x)')
  })
  it('input: ≤ 5 group_by columns, ≤ 10 metrics, known ops only', () => {
    expect(SummaryInput.safeParse({ set_id: '11111111-1111-4111-8111-111111111111', group_by: ['a'], metrics: [{ op: 'sum', column: 'b' }] }).success).toBe(true)
    expect(SummaryInput.safeParse({ set_id: '11111111-1111-4111-8111-111111111111', group_by: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false)
    expect(SummaryInput.safeParse({ set_id: '11111111-1111-4111-8111-111111111111', metrics: [{ op: 'median', column: 'b' }] }).success).toBe(false)
  })
})
