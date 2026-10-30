import { describe, expect, it, vi } from 'vitest'
import { ALWAYS_ASK_KINDS, HIGH_RISK_KIND, SKIPPABLE_KINDS, TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools, type ToolDeps } from '@/lib/agent/tools'
import { BUILTIN_SKILLS, PM_INFLUENCER_SKILL_ID } from '@/lib/agent/builtinSkills'

const RUN = '0b9f6a52-1c3e-4d7a-9f00-1234567890ab'

function setup(responses: Record<string, unknown> = {}, extra: Partial<ToolDeps> = {}) {
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    const path = url.replace('https://lume.test', '')
    const key = Object.keys(responses).find((k) => path.startsWith(k))
    const body = key ? responses[key] : { ok: true }
    const status = body && typeof body === 'object' && '__status' in body ? Number((body as { __status: number }).__status) : 200
    void init
    return new Response(JSON.stringify(body), { status })
  })
  const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
  const prepare = vi.fn(async ({ kind, payload }: { kind: string; payload: Record<string, unknown> }) => ({
    ok: true as const,
    kind,
    payload: { ...payload, summary: `built ${kind}` },
  }))
  const autoApprove = vi.fn()
  const tools = buildTools({
    fetch: fetch as never,
    createAction,
    prepare: prepare as never,
    agentRunId: 'r1',
    baseUrl: 'https://lume.test',
    secret: 's',
    skills: { list: async () => [], get: async () => null, findByName: async () => null, create: vi.fn() },
    ...extra,
    ...(extra.skipPermissions ? { autoApprove } : {}),
  })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const run = (name: string, input: unknown) => tool(name).run(tool(name).inputSchema.parse(input))
  return { fetch, createAction, prepare, autoApprove, tool, run }
}

describe('influencer tool tiers', () => {
  it('reads, low-risk writes and two money approvals', () => {
    expect([TOOL_TIERS.list_influencers, TOOL_TIERS.estimate_influencer_run, TOOL_TIERS.get_influencer_run]).toEqual(['read', 'read', 'read'])
    expect([TOOL_TIERS.export_influencer_csv, TOOL_TIERS.add_influencer, TOOL_TIERS.update_influencer, TOOL_TIERS.cancel_influencer_run]).toEqual(['low', 'low', 'low', 'low'])
    expect([TOOL_TIERS.start_influencer_run, TOOL_TIERS.approve_reactions]).toEqual(['high', 'high'])
    expect(HIGH_RISK_KIND.start_influencer_run).toBe('influencer_run')
    expect(HIGH_RISK_KIND.approve_reactions).toBe('influencer_reactions')
  })
  it('both approvals always ask, even in skip-permissions mode', async () => {
    for (const k of ['influencer_run', 'influencer_reactions'] as const) {
      expect(ALWAYS_ASK_KINDS.has(k)).toBe(true)
      expect(SKIPPABLE_KINDS.has(k)).toBe(false)
    }
    const { run, autoApprove } = setup({}, { skipPermissions: true })
    const out = await run('start_influencer_run', { slugs: ['peter-lohmann'], estimate_shown_to_owner: true })
    expect(out).toMatchObject({ status: 'awaiting_approval', action_id: 'a1' })
    expect(autoApprove).not.toHaveBeenCalled()
  })
})

describe('start_influencer_run / approve_reactions', () => {
  it('start files an influencer_run approval through the server builder, never a route', async () => {
    const { run, prepare, createAction, fetch } = setup()
    const out = await run('start_influencer_run', { slugs: ['peter-lohmann', 'jay-parsons'], max_verify_usd: 5, estimate_shown_to_owner: true })
    expect(prepare).toHaveBeenCalledWith({ kind: 'influencer_run', payload: { slugs: ['peter-lohmann', 'jay-parsons'], max_verify_usd: 5 } })
    expect(createAction.mock.calls[0][0]).toBe('influencer_run')
    expect(out).toMatchObject({ status: 'awaiting_approval', deep_link: '/actions/a1', summary: 'built influencer_run' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('start needs the estimate shown first and valid slugs', () => {
    const { tool } = setup()
    const s = tool('start_influencer_run').inputSchema
    expect(s.safeParse({ slugs: ['peter-lohmann'] }).success).toBe(false)
    expect(s.safeParse({ slugs: ['Peter Lohmann'], estimate_shown_to_owner: true }).success).toBe(false)
    expect(s.safeParse({ slugs: [], estimate_shown_to_owner: true }).success).toBe(false)
    expect(s.safeParse({ slugs: ['peter-lohmann'], max_verify_usd: 60, estimate_shown_to_owner: true }).success).toBe(false)
  })
  it('approve_reactions files an influencer_reactions approval for the run (lowercased)', async () => {
    const { run, prepare, createAction } = setup()
    await run('approve_reactions', { run_id: RUN.toUpperCase() })
    expect(prepare).toHaveBeenCalledWith({ kind: 'influencer_reactions', payload: { run_id: RUN } })
    expect(createAction.mock.calls[0][0]).toBe('influencer_reactions')
  })
  it('a refused build (e.g. run not awaiting) surfaces as an error', async () => {
    const { tool } = setup()
    const t = buildTools({
      fetch: vi.fn() as never, createAction: vi.fn(), agentRunId: 'r1',
      prepare: (async () => ({ ok: false, status: 409, error: 'run_not_awaiting_reactions (status running, stage verify)' })) as never,
    }).find((x) => x.name === 'approve_reactions')!
    void tool
    await expect(t.run({ run_id: RUN })).rejects.toThrow(/run_not_awaiting_reactions/)
  })
})

describe('read tools', () => {
  it('list_influencers and get_influencer_run call their routes', async () => {
    const { run, fetch } = setup({ '/api/influencers/runs/': { run: { id: RUN, status: 'awaiting_approval' } }, '/api/influencers': { influencers: [] } })
    await run('list_influencers', {})
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/influencers')
    const r = await run('get_influencer_run', { run_id: RUN })
    expect(fetch.mock.calls[1][0]).toBe(`https://lume.test/api/influencers/runs/${RUN}`)
    expect(r).toMatchObject({ run: { status: 'awaiting_approval' } })
    await run('get_influencer_run', {})
    expect(fetch.mock.calls[2][0]).toBe('https://lume.test/api/influencers/runs')
  })
  it('estimate_influencer_run passes the slugs and the Perplexity cap', async () => {
    const { run, fetch } = setup({ '/api/influencers/estimate': { estimate: { posts_usd_now: 1 } } })
    await run('estimate_influencer_run', { slugs: ['peter-lohmann', 'deb-newell'], max_verify_usd: 4 })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/influencers/estimate?slugs=peter-lohmann%2Cdeb-newell&max_verify_usd=4')
  })
})

describe('low tools', () => {
  it('export_influencer_csv posts the filters and returns the download link and the Apollo steps', async () => {
    const { run, fetch } = setup({ '/api/influencers/exports': { export_id: 'e1', rows: 97, download: '/api/influencers/exports/e1', steps: ['x'] } })
    const out = await run('export_influencer_csv', { min_door_count: 700, only_new: true, door_count_column: true })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://lume.test/api/influencers/exports')
    expect(JSON.parse(String(init.body))).toEqual({ min_door_count: 700, only_new: true, door_count_column: true })
    expect(out).toMatchObject({ status: 'ready', rows: 97, download: '/api/influencers/exports/e1' })
    expect(String(out.note)).toMatch(/create_order/)
  })
  it('export_influencer_csv says rows are marked exported at creation and the link downloads again', () => {
    const { tool } = setup()
    expect(tool('export_influencer_csv').description).toMatch(/marked exported when the export is created/)
    expect(tool('export_influencer_csv').description).toMatch(/download.*again/)
  })
  it('export_influencer_csv: nothing to export is a plain answer, not a failure', async () => {
    const { run } = setup({ '/api/influencers/exports': { __status: 422, error: 'nothing_to_export' } })
    expect(await run('export_influencer_csv', { only_new: true })).toMatchObject({ status: 'nothing_to_export' })
  })
  it('add_influencer / update_influencer / cancel_influencer_run call their routes', async () => {
    const { run, fetch } = setup()
    await run('add_influencer', { name: 'New Person', linkedin_url: 'https://www.linkedin.com/in/new-person/' })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/influencers')
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ name: 'New Person', linkedin_url: 'https://www.linkedin.com/in/new-person' })
    await run('update_influencer', { slug: 'mike-brewer', active: false })
    expect(fetch.mock.calls[1][0]).toBe('https://lume.test/api/influencers/mike-brewer')
    expect(fetch.mock.calls[1][1].method).toBe('PATCH')
    expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toEqual({ active: false })
    await run('cancel_influencer_run', { run_id: RUN })
    expect(fetch.mock.calls[2][0]).toBe(`https://lume.test/api/influencers/runs/${RUN}/cancel`)
  })
  it('add_influencer refuses a non-profile LinkedIn URL', () => {
    const { tool } = setup()
    expect(tool('add_influencer').inputSchema.safeParse({ name: 'X', linkedin_url: 'https://www.linkedin.com/company/x' }).success).toBe(false)
  })
})

describe('the built-in skill in list_skills / get_skill', () => {
  it('list_skills always returns the PM influencer skill first, marked built-in', async () => {
    const { run } = setup()
    const out = (await run('list_skills', {})) as { skills: { id: string; name: string; builtin?: boolean; steps: string[] }[] }
    expect(out.skills[0]).toMatchObject({ id: PM_INFLUENCER_SKILL_ID, builtin: true })
    expect(out.skills[0].name).toMatch(/PM influencer reactions/)
    expect(out.skills[0].steps.join(' ')).toMatch(/approve_reactions/)
  })
  it('get_skill finds it by id or name', async () => {
    const { run } = setup()
    expect(await run('get_skill', { id: PM_INFLUENCER_SKILL_ID })).toMatchObject({ skill: { id: PM_INFLUENCER_SKILL_ID } })
    expect(await run('get_skill', { name: BUILTIN_SKILLS[0].name.toUpperCase() })).toMatchObject({ skill: { builtin: true } })
  })
})
