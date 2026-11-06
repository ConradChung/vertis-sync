import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

let db = memdb({ lead_review_items: ['set_id', 'idx'] })
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/apollo/source', () => ({ loadSourceRows: vi.fn() }))

import { createReviewSetFromRows, loadRows } from '@/lib/review/store'

beforeEach(() => {
  db = memdb({ lead_review_items: ['set_id', 'idx'] })
})

describe('review set columns', () => {
  it("an actor run's set shows the actor's own fields: its key order, nested flattened, later keys appended; the mapped item stays as the helper", async () => {
    const rows = [
      { title: 'Roof Co', website: 'roof.co', location: { city: 'Austin', state: 'TX' }, categories: ['Roofer', 'Contractor'] },
      { title: 'Gutter Inc', phone: '555', email: 'g@gutter.co' },
    ]
    const { set } = await createReviewSetFromRows({ kind: 'run', id: 'abcdefgh12', label: 'run', rows })
    expect(set.columns).toEqual(['title', 'website', 'location.city', 'location.state', 'categories', 'phone', 'email'])
    const loaded = await loadRows(set.id)
    expect(loaded[0].cells).toEqual({ title: 'Roof Co', website: 'roof.co', 'location.city': 'Austin', 'location.state': 'TX', categories: 'Roofer; Contractor' })
    expect(loaded[1].item.email).toBe('g@gutter.co')
    expect(loaded[0].item.domain).toBe('roof.co')
  })
})
