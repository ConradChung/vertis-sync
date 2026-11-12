import { describe, expect, it, vi } from 'vitest'
import { ALWAYS_ASK_KINDS, HIGH_RISK_KIND, TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'
import { SYSTEM_PROMPT } from '@/lib/agent/prompt'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'

function setup() {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ unchecked: 3140 }), { status: 200 }))
  const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
  const prepare = vi.fn(async ({ kind, payload }: { kind: string; payload: Record<string, unknown> }) => ({ ok: true as const, kind, payload: { ...payload, summary: 'built' } }))
  const tools = buildTools({ fetch: fetch as never, createAction, prepare: prepare as never, agentRunId: 'r1', baseUrl: 'https://lume.test', secret: 's' })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const run = (name: string, input: unknown) => tool(name).run(tool(name).inputSchema.parse(input))
  return { fetch, createAction, prepare, run, tool }
}

describe('company check tools', () => {
  it('get_company_check is read; check_companies files a company_check that always asks', () => {
    expect([TOOL_TIERS.get_company_check, TOOL_TIERS.check_companies]).toEqual(['read', 'high'])
    expect(HIGH_RISK_KIND.check_companies).toBe('company_check')
    expect(ALWAYS_ASK_KINDS.has('company_check')).toBe(true)
  })
  it('get_company_check reads the route with the job, ICP and filters', async () => {
    const { run, fetch } = setup()
    await run('get_company_check', { job_id: JOB.toUpperCase(), icp: 'a property manager', fit: 'not_fit', limit: 20 })
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(`https://lume.test/api/company-check?job_id=${JOB}&icp=a+property+manager&fit=not_fit&limit=20`)
  })
  it('check_companies needs the estimate shown, and only proposes (no fetch)', async () => {
    const { run, tool, fetch, prepare, createAction } = setup()
    expect(() => tool('check_companies').inputSchema.parse({ job_id: JOB })).toThrow()
    const out = await run('check_companies', { job_id: JOB.toUpperCase(), max_usd: 10, estimate_shown_to_owner: true })
    expect(out).toMatchObject({ status: 'awaiting_approval', action_id: 'a1' })
    expect(prepare).toHaveBeenCalledWith({ kind: 'company_check', payload: { job_id: JOB, max_usd: 10 } })
    expect(createAction.mock.calls[0][0]).toBe('company_check')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('the prompt sends the agent to the read tool and forbids borrowed prices', () => {
    expect(SYSTEM_PROMPT).toMatch(/call get_company_check with the job_id/)
    expect(SYSTEM_PROMPT).toMatch(/file check_companies/)
    expect(SYSTEM_PROMPT).toMatch(/Never quote a per-company or per-lead price from the influencer pipeline/)
  })
})
