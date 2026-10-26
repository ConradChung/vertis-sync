import { describe, expect, it } from 'vitest'
import { summariseReplies, type ReplyRow } from '@/lib/crm/service'

const row = (deal_id: string, text: string | null, occurred_at: string): ReplyRow => ({
  deal_id,
  payload: text === null ? {} : { text },
  occurred_at,
})

describe('summariseReplies', () => {
  const since = '2026-10-12T00:00:00Z'
  const rows = [
    row('a', 'Latest from a', '2026-10-25T10:00:00Z'),
    row('b', null, '2026-10-24T10:00:00Z'), // unreadable payload: no snippet, still a stamp
    row('a', 'Older from a', '2026-10-20T10:00:00Z'),
    row('b', 'Readable from b', '2026-10-01T10:00:00Z'), // before the window: snippet only
    row('c', 'From c', '2026-10-22T10:00:00Z'),
  ]

  it('keeps the newest readable reply per deal and stamps inside the window', () => {
    const { snippets, stamps } = summariseReplies(rows, null, since)
    expect(snippets).toEqual({ a: 'Latest from a', b: 'Readable from b', c: 'From c' })
    expect(stamps).toEqual(['2026-10-25T10:00:00Z', '2026-10-24T10:00:00Z', '2026-10-20T10:00:00Z', '2026-10-22T10:00:00Z'])
  })

  it('limits snippets and stamps to the given deals', () => {
    const { snippets, stamps } = summariseReplies(rows, new Set(['a']), since)
    expect(snippets).toEqual({ a: 'Latest from a' })
    expect(stamps).toEqual(['2026-10-25T10:00:00Z', '2026-10-20T10:00:00Z'])
  })

  it('handles no replies', () => {
    expect(summariseReplies([], new Set(['a']), since)).toEqual({ snippets: {}, stamps: [] })
  })
})
