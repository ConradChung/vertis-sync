import { describe, expect, it, vi } from 'vitest'
import { TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'

const SET = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const CONV = '1a2b3c4d-1111-4222-8333-444455556666'

function setup(responses: unknown[]) {
  const fetch = vi.fn()
  for (const r of responses) fetch.mockResolvedValueOnce(new Response(JSON.stringify(r)))
  const tools = buildTools({
    fetch,
    createAction: vi.fn(),
    prepare: vi.fn() as never,
    agentRunId: 'r1',
    baseUrl: 'https://lume.test',
    secret: 's',
    conversationId: CONV,
  })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  return { fetch, tool }
}

describe('lead review tools', () => {
  it('have the right tiers', () => {
    expect(TOOL_TIERS).toMatchObject({
      load_actor_results: 'low',
      review_leads: 'read',
      filter_leads: 'low',
      restore_leads: 'low',
      export_for_apollo: 'low',
    })
    expect(TOOL_TIERS).not.toHaveProperty('enrich_with_apollo')
  })

  it('load_actor_results creates a set tied to the conversation', async () => {
    const { fetch, tool } = setup([{ set: { id: SET } }])
    const t = tool('load_actor_results')
    await t.run(t.inputSchema.parse({ run_id: 'abcDEF12345' }))
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://lume.test/api/review-sets')
    expect(JSON.parse(init.body)).toEqual({ source: { kind: 'run', id: 'abcDEF12345' }, conversation_id: CONV })
    expect(() => t.inputSchema.parse({ run_id: 'abcDEF12345', dataset_id: 'abcDEF12345' })).toThrow()
  })

  it('filter_leads posts structured criteria', async () => {
    const { fetch, tool } = setup([{ after: { kept: 3 } }])
    const t = tool('filter_leads')
    await t.run(t.inputSchema.parse({ set_id: SET, action: 'exclude', criteria: { missing: ['website'] }, reason: 'no site' }))
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`https://lume.test/api/review-sets/${SET}/filter`)
    expect(JSON.parse(init.body)).toEqual({ action: 'exclude', criteria: { missing: ['website'] }, reason: 'no site' })
    expect(() => t.inputSchema.parse({ set_id: SET, action: 'exclude', criteria: {} })).toThrow()
  })

  it('restore_leads needs a target', async () => {
    const t = setup([]).tool('restore_leads')
    expect(() => t.inputSchema.parse({ set_id: SET })).toThrow()
    expect(t.inputSchema.parse({ set_id: SET, all: true })).toMatchObject({ all: true })
  })

  it('export_for_apollo returns the kept-only download link and manual steps', async () => {
    const { tool } = setup([{ set: { title: 'Roofers' }, summary: { kept: 12, coverage: { website: 12 } } }])
    const t = tool('export_for_apollo')
    const out = (await t.run(t.inputSchema.parse({ set_id: SET }))) as Record<string, unknown>
    expect(out).toMatchObject({ status: 'ready', download: `/api/review-sets/${SET}/export`, rows: 12 })
    expect((out.steps as string[]).length).toBeGreaterThan(3)
  })
})
