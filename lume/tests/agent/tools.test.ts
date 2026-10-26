import { describe, expect, it, vi } from 'vitest'
import { TOOL_TIERS, HIGH_RISK_KIND } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'
import { orbStateFrom } from '@/lib/agent/orbState'

const JOB = '0b9f6a52-1c3e-4d7a-9f00-1234567890ab'

function setup(response: Response = new Response('{"ok":true}')) {
  const fetch = vi.fn().mockResolvedValue(response)
  const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
  const notify = vi.fn().mockResolvedValue({ ok: true })
  const tools = buildTools({ fetch, createAction, agentRunId: 'r1', baseUrl: 'https://lume.test/', secret: 's3cret', notify })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  return { fetch, createAction, notify, tools, tool }
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
      send_reply: { reply_to_uuid: 'e1', body: 'hi' },
      pause_campaign: { campaign_id: 'c1' },
      resume_campaign: { campaign_id: 'c1' },
      activate_campaign: { job_id: JOB },
      duplicate_campaign: { source_campaign_id: 'c1', name: 'copy' },
      delete_rule: { rule_id: JOB },
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
      expect(meta).toEqual({ agentRunId: 'r1' })
    }
    expect(fetch).not.toHaveBeenCalled()
    // job ids are lowercased for the pending_actions job anti-join
    expect(createAction.mock.calls[0][1].job_id).toBe(JOB)
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
})
