import { describe, expect, it, vi } from 'vitest'
import { HIGH_RISK_KIND, SKIPPABLE_KINDS, ALWAYS_ASK_KINDS, TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools, type ToolDeps } from '@/lib/agent/tools'

const CID = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'

function setup(body: unknown = { ok: true }, extra: Partial<ToolDeps> = {}) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
  const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
  const prepare = vi.fn(async ({ kind, payload }: { kind: string; payload: Record<string, unknown> }) => ({
    ok: true as const,
    kind,
    payload: { ...payload, summary: `built ${kind}` },
  }))
  const tools = buildTools({ fetch, createAction, prepare: prepare as never, agentRunId: 'r1', baseUrl: 'https://lume.test', secret: 's', ...extra })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const run = (name: string, input: unknown) => tool(name).run(tool(name).inputSchema.parse(input))
  return { fetch, createAction, prepare, tool, run }
}

describe('tiers', () => {
  it('list_campaign_leads / contact_usage read, create_cycle_out_rule low, remove_leads high + skippable', () => {
    expect(TOOL_TIERS.list_campaign_leads).toBe('read')
    expect(TOOL_TIERS.contact_usage).toBe('read')
    expect(TOOL_TIERS.create_cycle_out_rule).toBe('low')
    expect(TOOL_TIERS.remove_leads).toBe('high')
    expect(HIGH_RISK_KIND.remove_leads).toBe('remove_leads')
    expect(SKIPPABLE_KINDS.has('remove_leads')).toBe(true)
    expect(ALWAYS_ASK_KINDS.has('remove_leads')).toBe(false)
  })
})

describe('list_campaign_leads', () => {
  it('reads the campaign leads route with state and limit', async () => {
    const { fetch, run } = setup({ configured: true, leads: [], matched: 0 })
    const out = await run('list_campaign_leads', { campaign_id: CID, state: 'no_reply_after_days:14', limit: 50 })
    expect(fetch.mock.calls[0][0]).toBe(`https://lume.test/api/campaigns/${CID}/leads?state=no_reply_after_days%3A14&limit=50`)
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer s')
    expect(out).toMatchObject({ configured: true, matched: 0 })
  })
  it('refuses unknown states before calling anything', () => {
    const { tool } = setup()
    expect(() => tool('list_campaign_leads').inputSchema.parse({ campaign_id: CID, state: 'all' })).toThrow()
    expect(() => tool('list_campaign_leads').inputSchema.parse({ campaign_id: CID, state: 'no_reply_after_days:0' })).toThrow()
  })
  it('says clearly when Instantly is not configured', async () => {
    const { run } = setup({ configured: false })
    await expect(run('list_campaign_leads', { campaign_id: CID, state: 'replied' })).rejects.toThrow(/not configured.*INSTANTLY_API_KEY/)
  })
})

describe('contact_usage', () => {
  it('reads /api/instantly/usage', async () => {
    const { fetch, run } = setup({ configured: true, current: 900, limit: 1000, headroom: 100 })
    expect(await run('contact_usage', {})).toMatchObject({ current: 900, limit: 1000, headroom: 100 })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/instantly/usage')
  })
  it('not configured → a clear error, never a made-up number', async () => {
    const { run } = setup({ configured: false })
    await expect(run('contact_usage', {})).rejects.toThrow(/not configured/)
  })
})

describe('remove_leads', () => {
  it('files remove_leads with explicit ids', async () => {
    const { run, prepare, createAction, fetch } = setup()
    const out = await run('remove_leads', { campaign_id: CID, lead_ids: ['l1', 'l2'], reason: 'free cap' })
    expect(prepare.mock.calls[0][0]).toEqual({ kind: 'remove_leads', payload: { campaign_id: CID, lead_ids: ['l1', 'l2'], reason: 'free cap' } })
    expect(createAction.mock.calls[0][0]).toBe('remove_leads')
    expect(out).toMatchObject({ status: 'awaiting_approval' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('files remove_leads with a state filter', async () => {
    const { run, prepare } = setup()
    await run('remove_leads', { campaign_id: CID, state: 'finished_no_reply', older_than_days: 14, reason: 'cycle' })
    expect(prepare.mock.calls[0][0].payload).toEqual({ campaign_id: CID, filter: { state: 'finished_no_reply', older_than_days: 14 }, reason: 'cycle' })
  })
  it('needs exactly one of lead_ids or state, and never a replied/interested state', () => {
    const { tool } = setup()
    const s = tool('remove_leads').inputSchema
    expect(() => s.parse({ campaign_id: CID, reason: 'x' })).toThrow()
    expect(() => s.parse({ campaign_id: CID, reason: 'x', lead_ids: ['a'], state: 'bounced' })).toThrow()
    expect(() => s.parse({ campaign_id: CID, reason: 'x', state: 'replied' })).toThrow()
    expect(() => s.parse({ campaign_id: CID, reason: 'x', state: 'interested' })).toThrow()
    expect(() => s.parse({ campaign_id: CID, state: 'bounced' })).toThrow() // reason required
  })
  it('auto-runs in skip mode', async () => {
    const autoApprove = vi.fn().mockResolvedValue({ status: 'executed', result: { removed: 2 }, error: null })
    const { run } = setup({ ok: true }, { skipPermissions: true, autoApprove })
    expect(await run('remove_leads', { campaign_id: CID, state: 'bounced', reason: 'cap' })).toMatchObject({ status: 'auto_approved', result: { removed: 2 } })
  })
})

describe('create_cycle_out_rule', () => {
  it('POSTs an inactive cycle_out rule with defaults', async () => {
    const { fetch, run } = setup({ ok: true, rule: { id: 'r' } })
    await run('create_cycle_out_rule', { name: 'Cycle PM', campaign_id: CID })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://lume.test/api/rules')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      name: 'Cycle PM',
      campaign_id: CID,
      kind: 'cycle_out',
      cron: '0 7 * * *',
      params: { after_days: 14 },
      filter: {},
    })
  })
  it('passes after_days, refill_to, refill filter and cap', async () => {
    const { fetch, run } = setup({ ok: true })
    await run('create_cycle_out_rule', {
      name: 'C', campaign_id: CID, after_days: 21, refill_to: 900, refill_filter: { city: 'Austin' }, max_per_run: 500, cron: '0 6 * * 1-5',
    })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      name: 'C', campaign_id: CID, kind: 'cycle_out', cron: '0 6 * * 1-5', params: { after_days: 21, refill_to: 900 }, filter: { city: 'Austin' }, daily_cap: 500,
    })
  })
})
