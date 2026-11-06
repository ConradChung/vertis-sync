import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

let db = memdb({})
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
const h = vi.hoisted(() => ({ via: 'internal' as 'internal' | 'session', inScope: vi.fn() }))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: async () => ({ ok: true, via: h.via, user: null }) }))
vi.mock('@/lib/leads/lists/reviewRows', () => ({ reviewSetInScope: h.inScope }))
vi.mock('@/lib/review/store', () => ({ ensureCells: async (s: unknown) => s }))

import { POST } from '@/app/api/lead-summary/route'

const SET = '11111111-1111-4111-8111-111111111111'
const CONV = '33333333-3333-4333-8333-333333333333'
const req = (body: unknown) => new Request('http://x/api/lead-summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
let calls: Record<string, unknown>[] = []

beforeEach(() => {
  db = memdb({})
  calls = []
  h.via = 'internal'
  h.inScope.mockReset().mockResolvedValue(true)
  db.table('lead_review_sets').push({ id: SET, title: 'posts', kind: 'review', columns: ['author.name', 'stats.totalReactions'], all_columns: ['type', 'author.name', 'stats.totalReactions', 'company.name'], item_count: 3, archived_at: null, source_conversation_id: CONV })
  db.rpcs.lume_summarize_lead_set = (args) => {
    calls.push(args)
    return { group_count: 1, total_rows: 3, groups: [{ g1: 'Ann', n: 3, m1: 15 }], other: { groups: 0, rows: 0 } }
  }
})

describe('POST /api/lead-summary', () => {
  it('runs the SQL summary over kept rows by default and names the result columns', async () => {
    const res = await POST(req({ set_id: SET, group_by: ['author.name'], metrics: [{ op: 'sum', column: 'stats.totalReactions' }], conversation_id: CONV }))
    expect(await res.json()).toMatchObject({ total_rows: 3, groups: [{ 'author.name': 'Ann', count: 3, 'sum(stats.totalReactions)': 15 }] })
    expect(calls[0]).toEqual({ p_set: SET, p_group_by: ['author.name'], p_metrics: [{ op: 'sum', column: 'stats.totalReactions' }], p_status: 'kept', p_limit: 100, p_where: {} })
  })
  it('a column the set does not have is a 400 that lists the real columns; a missing set is 404', async () => {
    const bad = await POST(req({ set_id: SET, group_by: ['author'], conversation_id: CONV }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ unknown: ['author'], columns: ['type', 'author.name', 'stats.totalReactions', 'company.name'] })
    expect((await POST(req({ set_id: '22222222-2222-4222-8222-222222222222' }))).status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('any stored column works (not only the shown ones), with a where filter', async () => {
    await POST(req({ set_id: SET, group_by: ['company.name'], where: { type: 'post' }, conversation_id: CONV }))
    expect(calls[0]).toMatchObject({ p_group_by: ['company.name'], p_where: { type: 'post' } })
    const bad = await POST(req({ set_id: SET, where: { nope: 'x' }, conversation_id: CONV }))
    expect(bad.status).toBe(400)
  })
  it("the agent may only summarise a review set from its chat or project; the owner's page is not scoped", async () => {
    h.inScope.mockResolvedValue(false)
    expect((await POST(req({ set_id: SET, conversation_id: CONV }))).status).toBe(404)
    expect((await POST(req({ set_id: SET }))).status).toBe(404)
    h.via = 'session'
    expect((await POST(req({ set_id: SET }))).status).toBe(200)
  })
})
