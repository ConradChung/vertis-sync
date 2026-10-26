import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/** Minimal chainable fake of the supabase query builder for pipeline_diagrams. */
const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], inserts: 0 }))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const filters: [string, unknown][] = []
      let pending: Record<string, unknown> | null = null
      const match = () => db.rows.filter((r) => filters.every(([k, v]) => r[k] === v))
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        is: (k: string, v: unknown) => (filters.push([k, v]), q),
        maybeSingle: async () => ({ data: pending ?? match()[0] ?? null, error: null }),
        single: async () => ({ data: pending, error: null }),
        insert: (row: Record<string, unknown>) => {
          db.inserts++
          pending = { id: `id-${db.inserts}`, archived_at: null, ...row }
          db.rows.push(pending)
          return q
        },
      }
      return q
    },
  }),
}))

import { saveDiagram, specHash } from '@/lib/playground/diagrams'

const spec = { title: 'P', nodes: [{ id: 'a', label: 'A', kind: 'step' as const, state: 'planned' as const }], edges: [] }

describe('pipeline_diagrams store', () => {
  beforeEach(() => {
    db.rows = []
    db.inserts = 0
  })

  it('hashes specs independently of key order', () => {
    const reordered = { edges: [], nodes: [{ state: 'planned' as const, kind: 'step' as const, label: 'A', id: 'a' }], title: 'P' }
    expect(specHash(reordered)).toBe(specHash(spec))
    expect(specHash({ ...spec, title: 'Q' })).not.toBe(specHash(spec))
  })

  it('dedupes an identical spec instead of inserting twice', async () => {
    const a = await saveDiagram({ spec })
    const b = await saveDiagram({ spec, title: 'Another title' })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.diagram).toMatchObject({ id: a.diagram.id })
    expect(db.inserts).toBe(1)
  })

  it('titles a save from the spec when none is given', async () => {
    const { diagram } = await saveDiagram({ spec })
    expect(diagram.title).toBe('P')
  })
})
