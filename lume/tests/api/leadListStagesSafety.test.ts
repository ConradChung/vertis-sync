import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

// A tiny list cap, and an appendItems that can be told to fail, around the real store.
const DEFAULTS = { lead_review_items: (r: Record<string, unknown>) => ({ pipeline_step: r.pipeline_step ?? 1 }) }
let db = memdb({ lead_review_items: ['set_id', 'idx'] }, DEFAULTS)
const h = vi.hoisted(() => ({ failAppend: false }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: async () => ({ ok: true, via: 'session', user: null }) }))
vi.mock('@/lib/agent/projects', () => ({ getProject: vi.fn().mockResolvedValue(null), listProjects: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/leads/lists/model', async (orig) => ({ ...(await orig<typeof import('@/lib/leads/lists/model')>()), LIST_MAX_ITEMS: 3 }))
vi.mock('@/lib/leads/lists/store', async (orig) => {
  const real = await orig<typeof import('@/lib/leads/lists/store')>()
  return {
    ...real,
    appendItems: async (...args: Parameters<typeof real.appendItems>) => {
      if (h.failAppend) throw new Error('db down')
      return real.appendItems(...args)
    },
  }
})

import * as combineRoute from '@/app/api/lead-lists/combine/route'
import * as finalRoute from '@/app/api/lead-lists/[id]/final/route'
import { appendItems, createList } from '@/lib/leads/lists/store'
import { normaliseLead } from '@/lib/review/model'
import type { ListItem } from '@/lib/leads/lists/model'

const row = (p: Partial<ListItem>) => {
  const o = { company: p.name, ...p }
  return { raw: { ...o } as Record<string, unknown>, item: { ...normaliseLead({}), ...o } as ListItem, source: 'manual' as const, cells: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v ?? '')])) }
}
const req = (body: unknown) => new Request('http://x/api/lead-lists/combine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

let n = 0
async function list(name: string, rows: Partial<ListItem>[]) {
  const l = await createList({ name, created_by: 'owner' })
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  db.table('lead_review_sets').find((r) => r.id === l.id)!.id = id
  await appendItems(id, rows.map(row))
  return id
}

beforeEach(() => {
  db = memdb({ lead_review_items: ['set_id', 'idx'] }, DEFAULTS)
  h.failAppend = false
})

describe('combine and final safety (GTM-18)', () => {
  it('refuses a master with more rows than a list holds, in the preview and the save', async () => {
    const a = await list('A', [{ name: 'W', domain: 'w.com' }, { name: 'X', domain: 'x.com' }])
    const b = await list('B', [{ name: 'Y', domain: 'y.com' }, { name: 'Z', domain: 'z.com' }])
    const before = db.table('lead_review_sets').length
    for (const body of [{ list_ids: [a, b], preview: true }, { list_ids: [a, b], name: 'Too big' }]) {
      const res = await combineRoute.POST(req(body))
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: 'over_list_cap' })
    }
    expect(db.table('lead_review_sets')).toHaveLength(before)
  })

  it('deletes the new master or final sheet when filling it fails, so no half-made list is left', async () => {
    const a = await list('A', [{ name: 'X', domain: 'x.com', phone: '1' }])
    const b = await list('B', [{ name: 'Y', domain: 'y.com', phone: '2' }])
    const before = db.table('lead_review_sets').length
    h.failAppend = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await combineRoute.POST(req({ list_ids: [a, b], name: 'M' }))).status).toBe(500)
    expect(db.table('lead_review_sets')).toHaveLength(before)
    const filter = { rules: [{ criteria: { missing: ['phone'] }, reason: 'no phone' }] }
    expect((await finalRoute.POST(req({ filter, name: 'F' }), { params: Promise.resolve({ id: a }) })).status).toBe(500)
    expect(db.table('lead_review_sets')).toHaveLength(before)
    // The source rows did not move on a failed save.
    expect(db.table('lead_review_items').filter((r) => r.set_id === a).map((r) => r.pipeline_step)).toEqual([1])
  })
})
