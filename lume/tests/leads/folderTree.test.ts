import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

let db = memdb({})
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/agent/projects', () => ({ listProjects: async () => [{ id: 'p-1', name: 'Roofers' }], getProject: vi.fn() }))

import { folderTree } from '@/lib/leads/lists/service'
import { createList } from '@/lib/leads/lists/store'

beforeEach(() => {
  db = memdb({})
})

describe('folderTree', () => {
  it('projects, then Influencers (candidate sheets outside a project), then Unfiled', async () => {
    await createList({ name: 'Roof leads', created_by: 'agent', project_id: 'p-1' })
    await createList({ name: 'PM influencers', created_by: 'agent', sheet_kind: 'influencer_candidates', influencer_batch_id: 'b-1' })
    await createList({ name: 'Proj influencers', created_by: 'agent', project_id: 'p-1', sheet_kind: 'influencer_candidates', influencer_batch_id: 'b-2' })
    await createList({ name: 'Loose', created_by: 'owner' })
    const tree = await folderTree()
    expect(tree.map((f) => [f.kind, f.name, f.lists.map((l) => l.name).sort()])).toEqual([
      ['project', 'Roofers', ['Proj influencers', 'Roof leads']],
      ['influencers', 'Influencers', ['PM influencers']],
      ['unfiled', 'Unfiled', ['Loose']],
    ])
  })
})
