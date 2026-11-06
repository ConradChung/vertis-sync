import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

let db = memdb({})
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
import { reviewSetInScope } from '@/lib/leads/lists/reviewRows'

const SET = 's-1'
beforeEach(() => {
  db = memdb({})
  db.table('lead_review_sets').push({ id: SET, kind: 'review', source_conversation_id: 'c-1' })
  db.table('agent_conversations').push({ id: 'c-1', project_id: 'p-1' }, { id: 'c-2', project_id: 'p-1' }, { id: 'c-3', project_id: null })
})

describe('reviewSetInScope', () => {
  it('this chat, or another chat of the same project; never another chat or a list', async () => {
    expect(await reviewSetInScope(SET, 'c-1', null)).toBe(true)
    expect(await reviewSetInScope(SET, 'c-2', 'p-1')).toBe(true)
    expect(await reviewSetInScope(SET, 'c-3', null)).toBe(false)
    expect(await reviewSetInScope(SET, 'c-2', 'p-9')).toBe(false)
    db.table('lead_review_sets')[0].kind = 'list'
    expect(await reviewSetInScope(SET, 'c-1', null)).toBe(false)
  })
})
