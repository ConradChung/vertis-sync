import { describe, expect, it, vi } from 'vitest'
import { TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'

const KAS = { id: '466d9a53-6450-49df-a063-8e66437efa8b', name: 'Kaspen / Zenport' }
const JOBS = { id: '5b54bc53-ac4a-49a3-b13a-a299b2d6b38f', name: 'Job search / GTM roles' }
const ROW = '0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'
const gate = (id: string, v: typeof KAS | null) => ({ kind: 'jobs_fill', target_table: 'job_batches', target_id: id, title: `t-${id}`, subtitle: 's', actions: [], counts: {}, vertical_id: v?.id ?? null, vertical_name: v?.name ?? null })
const GATES = [gate('a', KAS), gate('b', JOBS), gate('c', JOBS), gate('d', null)]

function setup(tag: typeof KAS | null) {
  const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/gates')) return Response.json(GATES)
    if (url.endsWith('/api/tags') && (init.method ?? 'GET') === 'GET') return Response.json({ tags: [JOBS, KAS] })
    if (url.endsWith('/api/tags')) return Response.json({ item: { id: ROW, vertical_id: JOBS.id, vertical_name: JOBS.name } })
    if (url.includes('/api/tasks')) return Response.json({ tasks: [{ id: 't1', title: 'Kaspen follow-up', due_at: 'x', status: 'scheduled', vertical_id: KAS.id }, { id: 't2', title: 'Job pull', due_at: 'y', status: 'scheduled', vertical_id: JOBS.id }], linear: {} })
    if (url.endsWith('/api/progress')) return Response.json({ running: [{ key: 'job_batch:b', title: 'Jobs', label: 'Job-search batch', status: 'ordered', vertical_id: JOBS.id, vertical_name: JOBS.name }], recent: [] })
    return Response.json({})
  })
  const tools = buildTools({ fetch, createAction: vi.fn(), prepare: vi.fn() as never, agentRunId: 'r1', baseUrl: 'https://lume.test', secret: 's', tag })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const run = (name: string, input: unknown) => tool(name).run(tool(name).inputSchema.parse(input))
  return { fetch, run }
}

describe('tag-scoped to-do tools', () => {
  it('tiers: get_progress read, tag_item low', () => {
    expect(TOOL_TIERS.get_progress).toBe('read')
    expect(TOOL_TIERS.tag_item).toBe('low')
  })

  it('a Kaspen chat gets Kaspen gates, untagged briefly, job search as one line', async () => {
    const { run } = setup(KAS)
    const out = (await run('get_validation_queue', {})) as { gates: Record<string, unknown> }
    expect(out.gates).toMatchObject({ scope: 'tag', tag: 'Kaspen / Zenport', untagged: [{ target_id: 'd' }], other_tags: [{ tag: 'Job search / GTM roles', count: 2 }] })
    expect((out.gates.items as { target_id: string }[]).map((g) => g.target_id)).toEqual(['a'])
    expect(JSON.stringify(out)).not.toContain('t-b')
  })

  it('vertical / all widen it; an untagged chat gets everything grouped', async () => {
    const { run } = setup(KAS)
    expect(await run('get_validation_queue', { vertical: 'job search' })).toMatchObject({ gates: { scope: 'tag', tag: 'Job search / GTM roles' } })
    expect(await run('get_validation_queue', { all: true })).toMatchObject({ gates: { scope: 'all' } })
    const plain = setup(null)
    const out = (await plain.run('get_validation_queue', {})) as { gates: { scope: string; groups: { tag: string }[] } }
    expect(out.gates.scope).toBe('all')
    expect(out.gates.groups.map((g) => g.tag)).toEqual(['Job search / GTM roles', 'Kaspen / Zenport', 'Untagged'])
    // No tag list fetch unless a tag was typed.
    expect(plain.fetch.mock.calls.some(([u]) => String(u).endsWith('/api/tags'))).toBe(false)
  })

  it('list_tasks and get_progress are scoped the same way', async () => {
    const { run } = setup(KAS)
    const t = (await run('list_tasks', { from: '2026-11-01', to: '2026-12-01' })) as { tasks: { items: { id: string }[]; other_tags: unknown[] }; linear: unknown }
    expect(t.tasks.items.map((x) => x.id)).toEqual(['t1'])
    expect(t.tasks.other_tags).toHaveLength(1)
    expect(t.linear).toEqual({})
    const p = (await run('get_progress', {})) as { running: { items: unknown[]; other_tags: { note: string }[] } }
    expect(p.running.items).toEqual([])
    expect(p.running.other_tags[0].note).toBe('1 more running in Job search / GTM roles — ask to see them')
  })

  it('tag_item resolves the name and PATCHes /api/tags; untagged clears; an unknown tag fails before writing', async () => {
    const { run, fetch } = setup(KAS)
    expect(await run('tag_item', { table: 'job_batches', id: ROW, tag: 'recruiting job search' })).toEqual({ status: 'tagged', table: 'job_batches', id: ROW, tag: 'Job search / GTM roles' })
    const patch = fetch.mock.calls.find(([, i]) => i.method === 'PATCH')!
    expect(JSON.parse(patch[1].body)).toEqual({ table: 'job_batches', id: ROW, vertical_id: JOBS.id })
    await run('tag_item', { table: 'lume_tasks', id: ROW, tag: 'Untagged' })
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({ table: 'lume_tasks', id: ROW, vertical_id: null })
    const n = fetch.mock.calls.length
    await expect(run('tag_item', { table: 'job_batches', id: ROW, tag: 'dentists' })).rejects.toThrow(/No single tag matches "dentists"/)
    expect(fetch.mock.calls.slice(n).some(([, i]) => i.method === 'PATCH')).toBe(false)
  })
})
