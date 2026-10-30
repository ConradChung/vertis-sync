import { describe, expect, it, vi } from 'vitest'
import { TOOL_TIERS, HIGH_RISK_KIND } from '@/lib/agent/permissions'
import { buildTools, type ToolDeps } from '@/lib/agent/tools'
import { orbStateFrom, withStaleRun } from '@/lib/agent/orbState'

const JOB = '0b9f6a52-1c3e-4d7a-9f00-1234567890ab'

function setup(response: Response = new Response('{"ok":true}'), extra: Partial<ToolDeps> = {}) {
  const fetch = vi.fn().mockResolvedValue(response)
  const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
  const notify = vi.fn().mockResolvedValue({ ok: true })
  // Stand-in for buildActionRequest: echoes the request, adds a summary, and a ruleId for rule kinds.
  const prepare = vi.fn(async ({ kind, payload }: { kind: string; payload: Record<string, unknown> }) => ({
    ok: true as const,
    kind,
    payload: { ...payload, summary: `built ${kind}` },
    ...(kind === 'activate_rule' || kind === 'delete_rule' ? { ruleId: payload.rule_id as string } : {}),
  }))
  const tools = buildTools({
    fetch,
    createAction,
    prepare: prepare as never,
    agentRunId: 'r1',
    baseUrl: 'https://lume.test/',
    secret: 's3cret',
    notify,
    ...extra,
  })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  return { fetch, createAction, prepare, notify, tools, tool }
}

describe('buildTools', () => {
  it('builds exactly the tools in TOOL_TIERS, each at its tier', () => {
    const { tools } = setup()
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_TIERS).sort())
    for (const t of tools) expect(t.tier).toBe(TOOL_TIERS[t.name])
  })

  it('every high-risk tool creates its mapped pending action and never fetches', async () => {
    const inputs: Record<string, unknown> = {
      decide_validation: { callback_data: `ingest_ok:${JOB}`, job_id: JOB.toUpperCase() },
      assign_leads: { campaign_id: 'c1', filter: { city: 'Austin' }, limit: 50 },
      activate_rule: { rule_id: JOB },
      send_reply: { eaccount: 'me@send.com', reply_to_uuid: 'e1', body: 'hi' },
      pause_campaign: { campaign_id: 'c1' },
      resume_campaign: { campaign_id: 'c1' },
      activate_campaign: { job_id: JOB },
      duplicate_campaign: { source_campaign_id: 'c1', name: 'copy' },
      delete_rule: { rule_id: JOB },
      run_apify_actor: { actor_id: 'compass/crawler-google-places', input: { q: 'roofers' }, inputs_confirmed_by_owner: true },
      update_campaign_sequence: { campaign_id: 'c1', steps: [{ delay: 0, variants: [{ subject: 'Hi', body: 'Hello' }] }] },
      issue_operator_key: { vertical_id: JOB.toUpperCase(), label: 'Dentists bot' },
      remove_leads: { campaign_id: 'c1', state: 'bounced', reason: 'free the cap' },
    }
    const { fetch, createAction, tool } = setup()
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      if (tier !== 'high') continue
      const t = tool(name)
      const input = t.inputSchema.parse(inputs[name])
      const out = await t.run(input)
      expect(out).toMatchObject({ status: 'awaiting_approval', action_id: 'a1', deep_link: '/actions/a1' })
      const [kind, payload, by, meta] = createAction.mock.calls.at(-1)!
      expect(kind).toBe(HIGH_RISK_KIND[name])
      expect(typeof payload.summary).toBe('string')
      expect(by).toBe('agent')
      expect(payload.summary).toBe(`built ${HIGH_RISK_KIND[name]}`)
      expect(meta).toEqual(
        name === 'activate_rule' || name === 'delete_rule' ? { agentRunId: 'r1', ruleId: JOB } : { agentRunId: 'r1' }
      )
    }
    expect(fetch).not.toHaveBeenCalled()
    // job ids are lowercased for the pending_actions job anti-join
    expect(createAction.mock.calls[0][1].job_id).toBe(JOB)
  })

  it('high-risk tools send the POST /api/actions request shapes to the server builder', async () => {
    const { tool, prepare } = setup()
    const req = async (name: string, input: unknown) => {
      await tool(name).run(tool(name).inputSchema.parse(input))
      return prepare.mock.calls.at(-1)![0]
    }
    expect(await req('assign_leads', { campaign_id: 'c1', filter: { city: 'Austin' }, limit: 50 })).toEqual({
      kind: 'assign_leads',
      payload: { campaign_id: 'c1', filter: { city: 'Austin' }, limit: 50 },
    })
    expect(await req('assign_leads', { campaign_id: 'c1', filter: {} })).toEqual({
      kind: 'assign_leads',
      payload: { campaign_id: 'c1', filter: {} },
    })
    expect(await req('send_reply', { eaccount: 'me@send.com', reply_to_uuid: 'e1', body: 'hi' })).toEqual({
      kind: 'send_reply',
      payload: { eaccount: 'me@send.com', reply_to_uuid: 'e1', body: 'hi' },
    })
    expect(await req('resume_campaign', { campaign_id: 'c1' })).toEqual({ kind: 'resume_campaign', payload: { campaign_id: 'c1' } })
    expect(await req('duplicate_campaign', { source_campaign_id: 'c1', name: 'copy' })).toEqual({
      kind: 'create_campaign',
      payload: { source_campaign_id: 'c1', name: 'copy' },
    })
    expect(await req('activate_campaign', { job_id: JOB.toUpperCase() })).toEqual({ kind: 'launch_campaign', payload: { job_id: JOB } })
    expect(await req('activate_rule', { rule_id: JOB })).toEqual({ kind: 'activate_rule', payload: { rule_id: JOB } })
  })

  it('a refused build surfaces as an error and creates nothing', async () => {
    const { tool, prepare, createAction } = setup()
    prepare.mockResolvedValueOnce({ ok: false, status: 409, error: 'nothing_to_assign' } as never)
    await expect(tool('assign_leads').run({ campaign_id: 'c1', filter: {} })).rejects.toThrow(/nothing_to_assign/)
    expect(createAction).not.toHaveBeenCalled()
  })

  it('an SOP-refused sequence returns every violation to the model, so it fixes the copy', async () => {
    const { tool, prepare, createAction } = setup()
    prepare.mockResolvedValueOnce({
      ok: false,
      status: 422,
      error: 'sop_violations',
      problems: ['Step 1, variant A — banned_phrase: body uses the banned phrase "reach out" (“…”)', 'Step 4, variant A — signoff: must end with the sign-off "Frank Jing" (“Frank”)'],
    } as never)
    const t = tool('update_campaign_sequence')
    const err = await t.run(t.inputSchema.parse({ campaign_id: 'c1', steps: [{ delay: 0, variants: [{ subject: 'hi', body: 'x' }] }] })).catch((e: Error) => e)
    expect((err as Error).message).toBe(
      'update_sequence refused: sop_violations (HTTP 422)\n' +
        '- Step 1, variant A — banned_phrase: body uses the banned phrase "reach out" (“…”)\n' +
        '- Step 4, variant A — signoff: must end with the sign-off "Frank Jing" (“Frank”)\n' +
        'Rewrite the copy to fix every violation above, then call the tool again with the complete sequence.'
    )
    expect(createAction).not.toHaveBeenCalled()
  })

  it('get_sop lists the client SOPs and returns one merged with the base (read tier, no fetch)', async () => {
    const { tool, fetch } = setup()
    const t = tool('get_sop')
    expect(t.tier).toBe('read')
    expect(await t.run({})).toMatchObject({ clients: expect.arrayContaining([expect.objectContaining({ client: 'kaspen', name: 'Kaspen' })]) })
    const k = (await t.run({ client: 'Kaspen' })) as { client: string; sop: string }
    expect(k.client).toBe('kaspen')
    expect(k.sop).toMatch(/^Client SOP: Kaspen \(client id kaspen; applies to campaigns whose name contains "kaspen", "zenport"/)
    expect(k.sop).toMatch(/## Do not repeat these mistakes/)
    expect(await t.run({ client: 'nobody' })).toMatchObject({ status: 'not_found' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('assign_leads rejects a filter key the rule filter does not know', () => {
    const { tool } = setup()
    expect(tool('assign_leads').inputSchema.safeParse({ campaign_id: 'c1', filter: { state: 'TX' } }).success).toBe(false)
  })

  it('list_campaigns reads the analytics table', async () => {
    const { fetch, tool } = setup(new Response('{"campaigns":[],"instantly":"ok"}'))
    await expect(tool('list_campaigns').run({})).resolves.toEqual({ campaigns: [], instantly: 'ok' })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/campaigns?with=analytics')
  })

  it('a duplicate awaiting action points at the existing one', async () => {
    const { tool, createAction } = setup()
    createAction.mockRejectedValueOnce(Object.assign(new Error('dup'), { name: 'DuplicateActionError', existingId: 'old' }))
    await expect(tool('activate_campaign').run({ job_id: JOB })).resolves.toMatchObject({ action_id: 'old' })
  })

  it('decide_validation refuses buttons that have their own confirmation flow', () => {
    const { tool } = setup()
    const schema = tool('decide_validation').inputSchema
    for (const a of ['push_go', 'camp_launch', 'lume_ok', 'lume_no']) {
      expect(schema.safeParse({ callback_data: `${a}:${JOB}` }).success).toBe(false)
    }
  })

  it('read tools hit their route on LUME_URL with the bearer', async () => {
    const { fetch, tool } = setup()
    await tool('campaign_stats').run({ campaign_id: 'c 1' })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://lume.test/api/campaigns/c%201/analytics')
    expect(init.headers.Authorization).toBe('Bearer s3cret')
    expect(init.method).toBe('GET')
  })

  it('create_rotation_rule POSTs to /api/rules without an active flag', async () => {
    const { fetch, tool } = setup()
    await tool('create_rotation_rule').run({ name: 'r', campaign_id: 'c1', cron: '0 8 * * 1-5' })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://lume.test/api/rules')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ name: 'r', campaign_id: 'c1', cron: '0 8 * * 1-5', filter: {} })
    expect(body).not.toHaveProperty('active')
  })

  it('a failing route surfaces as a thrown error for the model', async () => {
    const { tool } = setup(new Response('{"error":"database"}', { status: 500 }))
    await expect(tool('list_rules').run({})).rejects.toThrow(/HTTP 500 database/)
  })

  it('draft_reply returns the draft and sends nothing', async () => {
    const { fetch, createAction, notify, tool } = setup()
    await expect(tool('draft_reply').run({ draft: 'Thanks!' })).resolves.toMatchObject({ status: 'draft_only', draft: 'Thanks!' })
    expect(fetch).not.toHaveBeenCalled()
    expect(createAction).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('notify goes through the injected Telegram sender', async () => {
    const { notify, tool } = setup()
    await expect(tool('notify').run({ text: 'done' })).resolves.toEqual({ status: 'sent' })
    expect(notify).toHaveBeenCalledWith('Lume agent: done')
  })
})

describe('skip-permissions mode', () => {
  const done = { status: 'executed' as const, result: { paused: true }, error: null }

  it('approves and executes a skippable kind at once', async () => {
    const autoApprove = vi.fn().mockResolvedValue(done)
    const { tool } = setup(undefined, { skipPermissions: true, autoApprove })
    const out = await tool('pause_campaign').run({ campaign_id: JOB })
    expect(autoApprove).toHaveBeenCalledWith('a1')
    expect(out).toMatchObject({ status: 'auto_approved', action_id: 'a1', deep_link: '/actions/a1', summary: 'built pause_campaign', outcome: 'executed', result: { paused: true } })
    expect(out).not.toHaveProperty('error')
  })

  it('carries a failed outcome and its error', async () => {
    const autoApprove = vi.fn().mockResolvedValue({ status: 'failed', result: null, error: 'boom' })
    const { tool } = setup(undefined, { skipPermissions: true, autoApprove })
    await expect(tool('pause_campaign').run({ campaign_id: JOB })).resolves.toMatchObject({ status: 'auto_approved', outcome: 'failed', error: 'boom' })
  })

  it('a claim that could not be made leaves it awaiting the owner', async () => {
    const autoApprove = vi.fn().mockResolvedValue({ status: 'failed', result: { still_awaiting: true }, error: 'db down' })
    const { tool } = setup(undefined, { skipPermissions: true, autoApprove })
    const out = await tool('pause_campaign').run({ campaign_id: JOB })
    expect(out).toEqual({
      status: 'awaiting_approval',
      action_id: 'a1',
      deep_link: '/actions/a1',
      summary: 'built pause_campaign',
      note: 'Skip mode could not auto-approve; it awaits the owner.',
    })
  })

  it('always-ask kinds still wait for the owner', async () => {
    const autoApprove = vi.fn().mockResolvedValue(done)
    const { tool } = setup(undefined, { skipPermissions: true, autoApprove })
    const out = await tool('send_reply').run({ eaccount: 'me@send.com', campaign_id: 'c', reply_to_uuid: 'e', body: 'hi' })
    expect(out).toMatchObject({ status: 'awaiting_approval', action_id: 'a1' })
    expect(autoApprove).not.toHaveBeenCalled()
  })

  it('off: skippable kinds wait too', async () => {
    const autoApprove = vi.fn().mockResolvedValue(done)
    const { tool } = setup(undefined, { skipPermissions: false, autoApprove })
    await expect(tool('pause_campaign').run({ campaign_id: JOB })).resolves.toMatchObject({ status: 'awaiting_approval' })
    expect(autoApprove).not.toHaveBeenCalled()
  })

  it('fails closed when the builder remaps the kind', async () => {
    const autoApprove = vi.fn().mockResolvedValue(done)
    const { tool, prepare, createAction } = setup(undefined, { skipPermissions: true, autoApprove })
    prepare.mockImplementationOnce(async ({ payload }) => ({ ok: true as const, kind: 'delete_rule', payload: { ...payload, summary: 's' } }))
    await expect(tool('pause_campaign').run({ campaign_id: JOB })).resolves.toMatchObject({ status: 'awaiting_approval' })
    expect(createAction.mock.calls[0][0]).toBe('delete_rule')
    expect(autoApprove).not.toHaveBeenCalled()
  })

  it('only skippable tools say they may auto-approve', () => {
    const { tool } = setup()
    expect(tool('pause_campaign').description).toContain('auto_approved')
    for (const name of ['send_reply', 'run_apify_actor', 'activate_campaign', 'resume_campaign', 'decide_validation']) {
      expect(tool(name).description).not.toContain('auto_approved')
    }
  })

  it('never auto-approves a duplicate', async () => {
    const autoApprove = vi.fn().mockResolvedValue(done)
    const { tool, createAction } = setup(undefined, { skipPermissions: true, autoApprove })
    createAction.mockRejectedValueOnce(Object.assign(new Error('dup'), { name: 'DuplicateActionError', existingId: 'old' }))
    await expect(tool('pause_campaign').run({ campaign_id: JOB })).resolves.toMatchObject({ status: 'awaiting_approval', action_id: 'old' })
    expect(autoApprove).not.toHaveBeenCalled()
  })
})

describe('Apify and campaign-launch tools', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body))

  it('search_apify_store and get_actor_input_schema are reads on Lume routes', async () => {
    const { fetch, tool } = setup()
    fetch.mockImplementation(async () => json({ actors: [] }))
    await tool('search_apify_store').run({ query: 'google maps roofers', limit: 3 })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/apify/store?q=google%20maps%20roofers&limit=3')
    await tool('get_actor_input_schema').run({ actor_id: 'compass/crawler-google-places' })
    expect(fetch.mock.calls[1][0]).toBe('https://lume.test/api/apify/actor?id=compass%2Fcrawler-google-places')
    expect(tool('get_actor_input_schema').description).toMatch(/ASK the owner/)
  })

  it('run_apify_actor needs the owner-confirmed flag and files run_actor without the flag in the payload', async () => {
    const { tool, prepare, fetch } = setup()
    const t = tool('run_apify_actor')
    expect(() => t.inputSchema.parse({ actor_id: 'a/b', input: {} })).toThrow()
    expect(() => t.inputSchema.parse({ actor_id: 'a/b', input: {}, inputs_confirmed_by_owner: true, max_charge_usd: 25 })).toThrow()
    await t.run(t.inputSchema.parse({ actor_id: 'a/b', input: { q: 1 }, max_charge_usd: 5, inputs_confirmed_by_owner: true }))
    expect(prepare).toHaveBeenCalledWith({ kind: 'run_actor', payload: { actor_id: 'a/b', input: { q: 1 }, max_charge_usd: 5 } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('get_campaign_sequence reads the editor route; update_campaign_sequence files update_sequence with defaults filled', async () => {
    const { tool, prepare, fetch } = setup()
    fetch.mockResolvedValueOnce(json({ configured: true, steps: [] }))
    await tool('get_campaign_sequence').run({ campaign_id: 'c1' })
    expect(fetch.mock.calls[0][0]).toMatch(/\/api\/campaigns\/c1\/sequence\/edit$/)
    const t = tool('update_campaign_sequence')
    expect(t.tier).toBe('high')
    await t.run(t.inputSchema.parse({ campaign_id: 'c1', steps: [{ delay: 0, variants: [{ subject: 'Hi', body: 'Hello', disabled: false }] }] }))
    expect(prepare).toHaveBeenCalledWith({
      kind: 'update_sequence',
      payload: { campaign_id: 'c1', steps: [{ delay: 0, delay_unit: 'days', variants: [{ subject: 'Hi', body: 'Hello' }] }] },
    })
  })

  it('import_actor_run stages a finished run through /api/import/apify, and waits on a running one', async () => {
    const { fetch, tool } = setup()
    fetch
      .mockResolvedValueOnce(json({ status: 'RUNNING', dataset_id: 'DS1', item_count: 10 }))
      .mockResolvedValueOnce(json({ status: 'SUCCEEDED', dataset_id: 'DS1', item_count: 812 }))
      .mockResolvedValueOnce(json({ job_id: 'j1' }))
    expect(await tool('import_actor_run').run({ run_id: 'RUN12345' })).toMatchObject({ status: 'not_ready', run_status: 'RUNNING' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await tool('import_actor_run').run({ run_id: 'RUN12345' })).toMatchObject({ status: 'staged', partial: false })
    const [url, init] = fetch.mock.calls[2]
    expect(url).toBe('https://lume.test/api/import/apify')
    expect(JSON.parse(init.body)).toEqual({ dataset_id: 'DS1' })
  })

  it('rank_campaigns ranks by reply rate over campaigns with enough sends', async () => {
    const { tool } = setup(
      json({
        instantly: 'ok',
        campaigns: [
          { name: 'Small', instantly_id: 'c0', status: 'active', sent: 20, replies: 5, reply_rate: 25, opportunities: 1, bounced: 0 },
          { name: 'Roofers Q3', instantly_id: 'c1', status: 'active', sent: 1200, replies: 49, reply_rate: 4.1, opportunities: 6, bounced: 24 },
          { name: 'Solar', instantly_id: 'c2', status: 'paused', sent: 900, replies: 18, reply_rate: 2, opportunities: 2, bounced: 9 },
        ],
      })
    )
    const out = (await tool('rank_campaigns').run({})) as { ranked: { name: string; bounce_rate_pct: number }[]; considered: number }
    expect(out.ranked.map((r) => r.name)).toEqual(['Roofers Q3', 'Solar'])
    expect(out.ranked[0].bounce_rate_pct).toBe(2)
    expect(out.considered).toBe(2)
  })
})

describe('orbStateFrom', () => {
  const run = (status: 'running' | 'needs_approval' | 'done' | 'failed', tool_calls: unknown[] = []) => ({ id: 'r', status, tool_calls })
  it('maps runs to orb states', () => {
    expect(orbStateFrom(null)).toBe('idle')
    expect(orbStateFrom(run('running'))).toBe('thinking')
    expect(orbStateFrom(run('running', [{ status: 'ok' }, { status: 'running' }]))).toBe('acting')
    expect(orbStateFrom(run('needs_approval'))).toBe('needs-approval')
    expect(orbStateFrom(run('needs_approval'), { approvalSettled: true })).toBe('idle')
    expect(orbStateFrom(run('done'))).toBe('idle')
    expect(orbStateFrom(run('failed'))).toBe('idle')
    expect(orbStateFrom(run('done'), { listening: true })).toBe('listening')
  })

  it('a running row older than 6 minutes counts as failed (idle), younger stays live', () => {
    const now = Date.parse('2026-10-25T12:00:00Z')
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
    expect(orbStateFrom({ ...run('running'), created_at: at(7) }, { now })).toBe('idle')
    expect(orbStateFrom({ ...run('running', [{ status: 'running' }]), created_at: at(30) }, { now })).toBe('idle')
    expect(orbStateFrom({ ...run('running'), created_at: at(5) }, { now })).toBe('thinking')
    expect(withStaleRun({ ...run('running'), created_at: at(7) }, now)?.status).toBe('failed')
    expect(withStaleRun({ ...run('needs_approval'), created_at: at(60) }, now)?.status).toBe('needs_approval')
    expect(withStaleRun({ ...run('running') }, now)?.status).toBe('running') // no timestamp: unchanged
    expect(withStaleRun(null, now)).toBeNull()
  })
})

describe('skill tools', () => {
  const saved = { id: '11111111-2222-4333-8444-555555555555', name: 'Roofers', description: 'd', steps: [{ type: 'launch' }], variables: [{ name: 'city', description: '' }], run_count: 2, last_run_at: null }
  function withSkills() {
    const store = {
      list: vi.fn().mockResolvedValue([saved]),
      get: vi.fn().mockResolvedValue(saved),
      findByName: vi.fn().mockResolvedValue(saved),
      create: vi.fn().mockResolvedValue({ ...saved, id: 'new-id' }),
    }
    const fetch = vi.fn()
    const tools = buildTools({ fetch, createAction: vi.fn(), prepare: vi.fn() as never, agentRunId: 'r1', baseUrl: 'https://lume.test', skills: store, conversationId: '22222222-3333-4444-8555-666666666666' })
    return { store, fetch, tool: (n: string) => tools.find((t) => t.name === n)! }
  }

  it('tiers: list_skills and get_skill read, save_skill low (never an approval)', () => {
    expect(TOOL_TIERS.list_skills).toBe('read')
    expect(TOOL_TIERS.get_skill).toBe('read')
    expect(TOOL_TIERS.save_skill).toBe('low')
    expect(HIGH_RISK_KIND.save_skill).toBeUndefined()
  })

  it('list_skills outlines steps; get_skill finds by id or by name', async () => {
    const { tool, store, fetch } = withSkills()
    expect(await tool('list_skills').run({})).toEqual({ skills: [{ id: saved.id, name: 'Roofers', description: 'd', steps: ['Launch'], variables: ['city'], run_count: 2, last_run_at: null }] })
    await tool('get_skill').run({ id: saved.id.toUpperCase() })
    expect(store.get).toHaveBeenCalledWith(saved.id)
    await tool('get_skill').run({ name: 'roofers' })
    expect(store.findByName).toHaveBeenCalledWith('roofers')
    store.findByName.mockResolvedValueOnce(null)
    await expect(tool('get_skill').run({ name: 'nope' })).rejects.toThrow(/No saved skill/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('save_skill validates, records the conversation and refuses undeclared placeholders', async () => {
    const { tool, store } = withSkills()
    const res = await tool('save_skill').run({ name: 'Roofers 2', steps: [{ type: 'duplicate_campaign', source_campaign_id: 'c1', name_template: 'Roofers {{city}}' }], variables: [{ name: 'city', description: 'City', default: 'Austin' }] })
    expect(res).toEqual({ status: 'saved', skill_id: 'new-id', name: 'Roofers', steps: 1 })
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Roofers 2', source_conversation_id: '22222222-3333-4444-8555-666666666666' }))
    await expect(tool('save_skill').run({ name: 'X', steps: [{ type: 'duplicate_campaign', source_campaign_id: 'c1', name_template: '{{town}}' }] })).rejects.toThrow(/placeholders without a variable: town/)
    await expect(tool('save_skill').run({ name: 'X', steps: [{ type: 'apify_actor', actor_id: 'a', budget_usd: 50 }] })).rejects.toThrow(/Skill refused/)
    expect(store.create).toHaveBeenCalledTimes(1)
  })

  it('skill tools fail cleanly without a store', async () => {
    const { tool } = setup()
    await expect(tool('list_skills').run({})).rejects.toThrow(/not available/)
  })
})

describe('vertical tools (G9)', () => {
  const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
  it('list_verticals reads /api/verticals (archived on request)', async () => {
    const { fetch, tool } = setup(new Response('{"verticals":[]}'))
    await tool('list_verticals').run({ include_archived: true })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/verticals?archived=1')
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer s3cret' } })
  })

  it('create_vertical posts name, scopes and campaigns, with no key', async () => {
    const { fetch, createAction, tool } = setup()
    const t = tool('create_vertical')
    await t.run(t.inputSchema.parse({ name: 'Dentists', scopes: ['campaign'], campaign_ids: ['c-1'] }))
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/verticals')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: 'Dentists', scopes: ['campaign'], campaign_ids: ['c-1'] })
    expect(createAction).not.toHaveBeenCalled()
  })

  it('update_vertical patches, or archives alone', async () => {
    const { fetch, tool } = setup()
    fetch.mockImplementation(async () => new Response('{"ok":true}'))
    const t = tool('update_vertical')
    await t.run(t.inputSchema.parse({ vertical_id: VID.toUpperCase(), name: 'Dental', campaign_ids: [] }))
    expect(fetch.mock.calls[0][0]).toBe(`https://lume.test/api/verticals/${VID}`)
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: 'Dental', campaign_ids: [] })
    await t.run(t.inputSchema.parse({ vertical_id: VID, archive: true }))
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ archived: true })
    expect(() => t.inputSchema.parse({ vertical_id: VID, archive: true, name: 'x' })).toThrow()
    expect(() => t.inputSchema.parse({ vertical_id: VID })).toThrow()
  })

  it('create_inbox_project is low and posts to the vertical\'s inbox-project route', async () => {
    const { fetch, createAction, tool } = setup()
    const t = tool('create_inbox_project')
    expect(t.tier).toBe('low')
    await t.run(t.inputSchema.parse({ vertical_id: VID.toUpperCase() }))
    expect(fetch.mock.calls[0][0]).toBe(`https://lume.test/api/verticals/${VID}/inbox-project`)
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(createAction).not.toHaveBeenCalled()
  })

  it('issue_operator_key is high, skippable, and only files a request for one vertical', async () => {
    const { createAction, tool } = setup()
    const t = tool('issue_operator_key')
    expect(t.tier).toBe('high')
    expect(t.description).toMatch(/auto_approved/)
    expect(() => t.inputSchema.parse({ master: true })).toThrow()
    await t.run(t.inputSchema.parse({ vertical_id: VID }))
    expect(createAction.mock.calls[0][0]).toBe('issue_operator_key')
    expect(createAction.mock.calls[0][1]).toMatchObject({ vertical_id: VID })
  })
})

describe('create_inbox_project for a vertical Grok Bot', () => {
  const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
  it('a vertical bot gets it, for its own vertical only (like the route)', async () => {
    const { fetch, tool, tools } = setup(undefined, { operator: { is_master: false, vertical_id: VID } })
    expect(tools.map((t) => t.name)).toContain('create_inbox_project')
    const t = tool('create_inbox_project')
    await t.run(t.inputSchema.parse({ vertical_id: VID.toUpperCase() }))
    expect(fetch.mock.calls[0][0]).toBe(`https://lume.test/api/verticals/${VID}/inbox-project`)
    await expect(t.run(t.inputSchema.parse({ vertical_id: '0b9f6a52-1c3e-4d7a-9f00-1234567890ab' }))).rejects.toThrow(/own vertical/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('the master bot and the owner may for any vertical', async () => {
    for (const operator of [{ is_master: true, vertical_id: null }, null]) {
      const { fetch, tool } = setup(undefined, { operator })
      const t = tool('create_inbox_project')
      await t.run(t.inputSchema.parse({ vertical_id: '0b9f6a52-1c3e-4d7a-9f00-1234567890ab' }))
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })
})

describe('send_reply on an Auto-mode campaign', () => {
  it('reports auto_approved_by_campaign when the grant approved it at creation', async () => {
    const { createAction, tool } = setup()
    createAction.mockResolvedValue({ id: 'a9', status: 'approved', decided_via: 'grant' })
    const t = tool('send_reply')
    const out = await t.run(t.inputSchema.parse({ eaccount: 'me@send.com', reply_to_uuid: 'e1', body: 'hi' }))
    expect(out).toMatchObject({ status: 'auto_approved_by_campaign', action_id: 'a9' })
  })
})

describe('master-only vertical tools', () => {
  it('a vertical Grok Bot run gets list_verticals but not create/update_vertical or issue_operator_key', () => {
    const names = (operator: { is_master: boolean } | null) => setup(undefined, { operator }).tools.map((t) => t.name)
    const vert = names({ is_master: false })
    expect(vert).toContain('list_verticals')
    for (const n of ['create_vertical', 'update_vertical', 'issue_operator_key']) {
      expect(vert).not.toContain(n)
      expect(names({ is_master: true })).toContain(n)
      expect(names(null)).toContain(n)
    }
  })
})
