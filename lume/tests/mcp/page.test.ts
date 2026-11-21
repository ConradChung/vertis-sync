import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, olderThan, pageOf } from '@/lib/mcp/page'

describe('cursor', () => {
  it('round-trips', () => {
    const c = encodeCursor('2026-11-19T10:00:00.123456+00:00', 42)
    expect(decodeCursor(c)).toEqual({ t: '2026-11-19T10:00:00.123456+00:00', id: '42' })
    expect(decodeCursor(undefined)).toBeNull()
  })

  it('rejects tampered cursors (they feed a PostgREST filter)', () => {
    const bad = Buffer.from(JSON.stringify({ t: '2026-11-19T10:00:00Z),id.gt.0', id: '1' })).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(/Invalid cursor/)
    const badId = Buffer.from(JSON.stringify({ t: '2026-11-19T10:00:00Z', id: '1,or(x' })).toString('base64url')
    expect(() => decodeCursor(badId)).toThrow(/Invalid cursor/)
    expect(() => decodeCursor('not base64 json')).toThrow(/Invalid cursor/)
  })

  it('builds the keyset filter', () => {
    expect(olderThan({ t: 'T', id: '9' })).toBe('created_at.lt.T,and(created_at.eq.T,id.lt.9)')
  })

  it('pages a limit+1 batch', () => {
    const rows = [1, 2, 3].map((i) => ({ id: i, created_at: `2026-11-1${i}T00:00:00Z` }))
    const p = pageOf(rows, 2)
    expect(p.rows).toHaveLength(2)
    expect(decodeCursor(p.next_cursor!)).toEqual({ t: '2026-11-12T00:00:00Z', id: '2' })
    expect(pageOf(rows, 5).next_cursor).toBeNull()
  })
})
