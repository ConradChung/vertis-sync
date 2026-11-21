import { describe, expect, it } from 'vitest'
import { summarizeAlerts } from '@/lib/mcp/tools/overview'

const a = (id: string, severity: string, created_at: string, source = 'x') => ({ id, severity, source, title: `t${id}`, created_at })

describe('summarizeAlerts', () => {
  const rows = [
    a('1', 'info', '2026-11-20T00:00:00Z'),
    a('2', 'urgent', '2026-11-01T00:00:00Z', 'lume.actions'),
    a('3', 'warn', '2026-11-19T00:00:00Z'),
    a('4', 'urgent', '2026-11-15T00:00:00Z', 'lume.actions'),
    a('5', 'info', '2026-10-30T00:00:00Z'),
  ]

  it('counts everything but returns only the top N, urgent first then newest', () => {
    const s = summarizeAlerts(rows, 132, 3)
    expect(s.unacked).toBe(132)
    expect(s.by_severity).toEqual({ info: 2, urgent: 2, warn: 1 })
    expect(s.by_source_top10).toEqual({ x: 3, 'lume.actions': 2 })
    expect(s.top.map((t) => t.id)).toEqual(['4', '2', '3'])
    expect(s.oldest_unacked_at).toBe('2026-10-30T00:00:00Z')
  })

  it('wraps titles as untrusted and honours n = 0', () => {
    expect(summarizeAlerts(rows, 5, 1).top[0].title).toEqual({ untrusted: 't4' })
    expect(summarizeAlerts(rows, 5, 0).top).toEqual([])
  })
})
