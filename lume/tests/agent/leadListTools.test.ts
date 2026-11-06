import { describe, expect, it, vi } from 'vitest'
import { ALWAYS_ASK_KINDS, HIGH_RISK_KIND, SKIPPABLE_KINDS, TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'

const LIST = '0F3C2B1A-9D8E-4F7A-8B6C-5D4E3F2A1B0C'
const FILE = '1F3C2B1A-9D8E-4F7A-8B6C-5D4E3F2A1B0C'
const SET = '2f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const CONV = '1a2b3c4d-1111-4222-8333-444455556666'
const PROJECT = '3a2b3c4d-1111-4222-8333-444455556666'
const EXPORT = '4a2b3c4d-1111-4222-8333-444455556666'

type Reply = (url: string, init: { method?: string; body?: string }) => unknown
function setup(opts: { projectId?: string | null; skip?: boolean; reply?: Reply } = {}) {
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => new Response(JSON.stringify(opts.reply?.(url, init) ?? { ok: true }), { status: 200 }))
  const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
  const prepare = vi.fn(async ({ kind, payload }: { kind: string; payload: Record<string, unknown> }) => ({ ok: true as const, kind, payload: { ...payload, summary: 's' } }))
  const autoApprove = vi.fn()
  const tools = buildTools({ fetch: fetch as never, createAction, prepare: prepare as never, agentRunId: 'r', baseUrl: 'https://lume.test', secret: 's', conversationId: CONV, projectId: opts.projectId ?? null, skipPermissions: opts.skip, autoApprove })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const run = (n: string, input: unknown) => tool(n).run(tool(n).inputSchema.parse(input))
  const calls = () => fetch.mock.calls.map(([url, init]) => ({ url: String(url).replace('https://lume.test', ''), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined }))
  return { fetch, prepare, createAction, autoApprove, tool, run, calls }
}

describe('lead list tools', () => {
  it('tiers: list/view read; create/append/remove/rename low (they spend nothing); send and delete always ask', () => {
    expect([TOOL_TIERS.list_lead_lists, TOOL_TIERS.view_lead_list]).toEqual(['read', 'read'])
    expect([TOOL_TIERS.create_lead_list, TOOL_TIERS.append_to_lead_list, TOOL_TIERS.remove_from_lead_list, TOOL_TIERS.rename_lead_list]).toEqual(['low', 'low', 'low', 'low'])
    expect([HIGH_RISK_KIND.send_lead_list_to_validation, HIGH_RISK_KIND.delete_lead_list]).toEqual(['send_lead_list', 'delete_lead_list'])
    for (const k of ['send_lead_list', 'delete_lead_list'] as const) {
      expect(ALWAYS_ASK_KINDS.has(k)).toBe(true)
      expect(SKIPPABLE_KINDS.has(k)).toBe(false)
    }
  })

  it('create files the list in this chat’s project by default and returns the lead_list ref', async () => {
    const { run, calls } = setup({ projectId: PROJECT, reply: () => ({ list: { id: LIST.toLowerCase(), name: 'PM owners' }, href: '/import/leads?list=x' }) })
    const r = (await run('create_lead_list', { name: 'PM owners', notes: 'texas' })) as Record<string, unknown>
    expect(calls()[0]).toEqual({ url: '/api/lead-lists', method: 'POST', body: { name: 'PM owners', notes: 'texas', project_id: PROJECT } })
    expect(r.lead_list).toMatchObject({ list_id: LIST.toLowerCase(), name: 'PM owners' })
  })

  it('append maps each source; inline rows capped at 200; returns the report line', async () => {
    const { run, calls } = setup({ projectId: PROJECT, reply: () => ({ list_id: LIST.toLowerCase(), name: 'L', added: 2, duplicates: 1, line: 'added 2, 1 duplicate skipped → L' }) })
    await run('append_to_lead_list', { list_id: LIST, source: 'attachment', file_id: FILE, sheet: 'S1' })
    await run('append_to_lead_list', { list_id: LIST, source: 'review_set', set_id: SET })
    await run('append_to_lead_list', { list_id: LIST, source: 'actor_run', run_id: 'abcdefgh12' })
    await run('append_to_lead_list', { list_id: LIST, source: 'influencer_export', export_id: EXPORT })
    const r = (await run('append_to_lead_list', { list_id: LIST, source: 'inline', rows: [{ name: 'A', email: 'a@a.co' }] })) as Record<string, unknown>
    const bodies = calls().map((c) => c.body.source)
    expect(bodies).toEqual([
      { kind: 'attachment', file_id: FILE.toLowerCase(), sheet: 'S1' },
      { kind: 'review_set', set_id: SET },
      { kind: 'actor_run', run_id: 'abcdefgh12' },
      { kind: 'influencer_export', export_id: EXPORT },
      { kind: 'inline', rows: [{ name: 'A', email: 'a@a.co' }] },
    ])
    expect(calls()[0]).toMatchObject({ url: `/api/lead-lists/${LIST.toLowerCase()}/items`, method: 'POST', body: { conversation_id: CONV, project_id: PROJECT } })
    expect(r).toMatchObject({ lead_list: { list_id: LIST.toLowerCase(), line: 'added 2, 1 duplicate skipped → L' } })
    expect(() => setup().tool('append_to_lead_list').inputSchema.parse({ list_id: LIST, source: 'inline', rows: Array.from({ length: 201 }, () => ({ email: 'a@a.co' })) })).toThrow()
  })

  it("append without a list_id goes to the project's list in a project chat, and is refused outside one", async () => {
    const inProject = setup({ projectId: PROJECT, reply: () => ({ appended: { list_id: LIST.toLowerCase(), name: 'Roofers', added: 1, duplicates: 0, line: 'added 1, 0 duplicates skipped → Roofers' } }) })
    const r = (await inProject.run('append_to_lead_list', { source: 'inline', rows: [{ email: 'a@a.co' }] })) as Record<string, unknown>
    expect(inProject.calls()[0]).toMatchObject({ url: '/api/lead-lists/auto', body: { project_id: PROJECT, conversation_id: CONV, source: { kind: 'inline' } } })
    expect(r.lead_list).toMatchObject({ name: 'Roofers' })
    const outside = setup()
    await expect(outside.run('append_to_lead_list', { source: 'inline', rows: [{ email: 'a@a.co' }] })).rejects.toThrow(/list_id/)
  })

  it('bulk removal (q, missing, or more than 25 rows) only files an always-ask approval; a few explicit rows go straight through', async () => {
    expect(HIGH_RISK_KIND.remove_from_lead_list).toBe('remove_lead_rows')
    expect(ALWAYS_ASK_KINDS.has('remove_lead_rows')).toBe(true)
    const { run, prepare, fetch, autoApprove } = setup({ skip: true })
    for (const input of [{ q: 'acme' }, { missing: ['email'] }, { idxs: Array.from({ length: 26 }, (_, i) => i) }]) {
      const r = (await run('remove_from_lead_list', { list_id: LIST, ...input })) as Record<string, unknown>
      expect(r.status).toBe('awaiting_approval')
    }
    expect(prepare.mock.calls.map((c) => c[0].kind)).toEqual(['remove_lead_rows', 'remove_lead_rows', 'remove_lead_rows'])
    expect(prepare.mock.calls[0][0].payload).toEqual({ list_id: LIST.toLowerCase(), q: 'acme' })
    expect(fetch).not.toHaveBeenCalled()
    expect(autoApprove).not.toHaveBeenCalled()
  })

  it('view pages the list; remove and rename hit the list routes', async () => {
    const { run, calls } = setup({ reply: (url) => (url.includes('/items?') ? { rows: [], total: 0 } : { list: { id: LIST.toLowerCase(), name: 'L' }, removed: 3 }) })
    await run('view_lead_list', { list_id: LIST, q: 'acme', sort: 'company', page: 1, page_size: 20 })
    await run('remove_from_lead_list', { list_id: LIST, idxs: [3, 4] })
    await run('rename_lead_list', { list_id: LIST, name: 'New', project_id: null })
    expect(calls().map((c) => [c.method, c.url])).toEqual([
      ['GET', `/api/lead-lists/${LIST.toLowerCase()}`],
      ['GET', `/api/lead-lists/${LIST.toLowerCase()}/items?page=1&page_size=20&sort=company&dir=asc&q=acme`],
      ['DELETE', `/api/lead-lists/${LIST.toLowerCase()}/items`],
      ['PATCH', `/api/lead-lists/${LIST.toLowerCase()}`],
    ])
    expect(calls()[2].body).toEqual({ idxs: [3, 4] })
    expect(calls()[3].body).toEqual({ name: 'New', project_id: null })
  })

  it('send and delete only file approvals, even with skip permissions on', async () => {
    const { run, prepare, createAction, autoApprove, fetch } = setup({ skip: true })
    await run('send_lead_list_to_validation', { list_id: LIST })
    await run('delete_lead_list', { list_id: LIST })
    expect(prepare.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'send_lead_list', payload: { list_id: LIST.toLowerCase() } },
      { kind: 'delete_lead_list', payload: { list_id: LIST.toLowerCase() } },
    ])
    expect(createAction).toHaveBeenCalledTimes(2)
    expect(autoApprove).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('in a project chat, loading actor results / an attachment / an influencer export auto-appends to the project list and reports it', async () => {
    const { run, calls } = setup({
      projectId: PROJECT,
      reply: (url) =>
        url.endsWith('/api/lead-lists/auto')
          ? { appended: { list_id: LIST.toLowerCase(), name: 'Roofers', added: 40, duplicates: 2, line: 'added 40, 2 duplicates skipped → Roofers' } }
          : url.endsWith('/api/influencers/exports')
            ? { export_id: EXPORT, rows: 42 }
            : { set: { id: SET }, summary: {} },
    })
    const loaded = (await run('load_actor_results', { run_id: 'abcdefgh12' })) as Record<string, unknown>
    expect(calls()[1]).toEqual({ url: '/api/lead-lists/auto', method: 'POST', body: { project_id: PROJECT, conversation_id: CONV, source: { kind: 'review_set', set_id: SET } } })
    expect(loaded.lead_list).toMatchObject({ line: 'added 40, 2 duplicates skipped → Roofers' })
    await run('load_attachment_as_leads', { file_id: FILE })
    expect(calls()[3].body.source).toEqual({ kind: 'review_set', set_id: SET })
    await run('export_influencer_csv', { min_door_count: 700 })
    expect(calls()[5].body.source).toEqual({ kind: 'influencer_export', export_id: EXPORT })
  })

  it('outside a project nothing is appended; the result suggests saving to a list. A failed auto-append never fails the load', async () => {
    const out = setup({ reply: () => ({ set: { id: SET }, summary: {} }) })
    const r = (await out.run('load_actor_results', { run_id: 'abcdefgh12' })) as Record<string, unknown>
    expect(out.calls()).toHaveLength(1)
    expect(String(r.lead_list_hint)).toMatch(/create_lead_list/)
    const failing = setup({ projectId: PROJECT, reply: (url) => (url.endsWith('/auto') ? undefined : { set: { id: SET } }) })
    failing.fetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/auto') ? new Response(JSON.stringify({ error: 'boom' }), { status: 500 }) : new Response(JSON.stringify({ set: { id: SET } }), { status: 200 })
    )
    const ok = (await failing.run('load_actor_results', { run_id: 'abcdefgh12' })) as Record<string, unknown>
    expect(ok.set).toEqual({ id: SET })
    expect(String(ok.lead_list_error)).toMatch(/500/)
  })
})

describe('actor columns for analysis', () => {
  it('summarize_lead_set (read) posts the group-by / metrics to the SQL summary, for a set or a list', async () => {
    expect(TOOL_TIERS.summarize_lead_set).toBe('read')
    const { run, calls } = setup({ reply: () => ({ total_rows: 3, groups: [] }) })
    await run('summarize_lead_set', { set_id: SET, group_by: ['author.name'], metrics: [{ op: 'sum', column: 'stats.totalReactions' }, { op: 'count_distinct', column: 'author.profileUrl' }] })
    await run('summarize_lead_set', { list_id: LIST })
    expect(calls()[0]).toEqual({ url: '/api/lead-summary', method: 'POST', body: { set_id: SET, group_by: ['author.name'], metrics: [{ op: 'sum', column: 'stats.totalReactions' }, { op: 'count_distinct', column: 'author.profileUrl' }] } })
    expect(calls()[1].body).toEqual({ set_id: LIST.toLowerCase() })
    expect(() => setup().tool('summarize_lead_set').inputSchema.parse({ set_id: SET, list_id: LIST })).toThrow()
  })

  it('review_leads and view_lead_list can return just the chosen raw columns', async () => {
    const { run } = setup({
      reply: (url) =>
        url.includes('/items?')
          ? { rows: [{ idx: 0, status: 'kept', item: { name: 'x' }, cells: { 'author.name': 'Ann', 'stats.totalReactions': '10', text: 'long' } }], total: 1 }
          : { set: { id: SET, title: 'posts', columns: ['author.name', 'stats.totalReactions', 'text'] }, list: { id: LIST, name: 'L', columns: ['author.name'] }, summary: {} },
    })
    const r = (await run('review_leads', { set_id: SET, columns: ['author.name', 'stats.totalReactions'] })) as { columns: string[]; page: { rows: unknown[] } }
    expect(r.columns).toEqual(['author.name', 'stats.totalReactions', 'text'])
    expect(r.page.rows).toEqual([{ idx: 0, status: 'kept', cells: { 'author.name': 'Ann', 'stats.totalReactions': '10' } }])
    const v = (await run('view_lead_list', { list_id: LIST, columns: ['author.name'] })) as { page: { rows: unknown[] } }
    expect(v.page.rows).toEqual([{ idx: 0, status: 'kept', cells: { 'author.name': 'Ann' } }])
  })

  it('load_actor_results says when the run had more items than were loaded', async () => {
    const { run } = setup({ reply: () => ({ set: { id: SET }, truncated: true, source_rows: 7200, dataset_item_count: 7200, summary: {} }) })
    const r = (await run('load_actor_results', { run_id: 'abcdefgh12' })) as Record<string, unknown>
    expect(String(r.cap_note)).toMatch(/5,000 of 7,200/)
  })
})
