import { describe, expect, it, vi } from 'vitest'
import {
  INCOMPLETE_REPLY,
  PORTAL_AGENT_MAX_ITERATIONS,
  REFUSAL_REPLY,
  SEARCH_LEADS_TOOL,
  SearchLeadsInput,
  capMessages,
  runPortalAgent,
} from '@/lib/portal/agent'
import type { PortalLead } from '@/lib/portal/types'
import type { PortalUser } from '@/lib/portal/access'

const user: PortalUser = { email: 'frank@getzenport.com', client: 'Kaspen', campaign_ids: ['c1'], linkedin_set_ids: [], sheet_set_ids: [] }
const lead = (id: string): PortalLead => ({
  id, kind: 'email', name: `Lead ${id}`, first_name: null, title: null, company: 'Acme', phone: '1', phone_type: 'mobile', email: null,
  website: null, linkedin_url: null, city: null, state: null, country: null, region: 'Texas', timezone: null, campaign: 'K',
  reply_status: null, opened: false, replied: false,
})

const msg = (stop_reason: string, content: unknown[]) => ({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason, content, usage: {} }) as never
const toolUse = (id: string, input: unknown, name = 'search_leads') => ({ type: 'tool_use', id, name, input })
const text = (t: string) => ({ type: 'text', text: t })

describe('search_leads tool', () => {
  it('is strict with no extra properties', () => {
    expect(SEARCH_LEADS_TOOL.strict).toBe(true)
    expect(SEARCH_LEADS_TOOL.input_schema.additionalProperties).toBe(false)
  })
  it('validates and clamps input', () => {
    expect(SearchLeadsInput.parse({})).toEqual({ q: undefined, region: undefined, has_phone: undefined, tab: 'email', limit: 10 })
    expect(SearchLeadsInput.parse({ q: ' acme ', limit: 500, tab: 'linkedin' })).toMatchObject({ q: 'acme', limit: 20, tab: 'linkedin' })
    expect(SearchLeadsInput.parse({ limit: -3 }).limit).toBe(1)
    expect(SearchLeadsInput.safeParse({ campaign_ids: ['x'] }).success).toBe(false)
    expect(SearchLeadsInput.safeParse({ tab: 'sms' }).success).toBe(false)
    expect(SearchLeadsInput.safeParse({ limit: 2.5 }).success).toBe(false)
  })
})

describe('capMessages', () => {
  it('keeps the last 12, trims to 2,000 chars, starts and ends with a user turn', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` }))
    many.push({ role: 'user', content: 'x'.repeat(5000) })
    const out = capMessages(many)!
    expect(out.length).toBeLessThanOrEqual(12)
    expect(out[0].role).toBe('user')
    expect(out.at(-1)!.content).toHaveLength(2000)
    expect(capMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])).toBeNull()
    expect(capMessages([{ role: 'user', content: '   ' }])).toBeNull()
  })
})

describe('runPortalAgent', () => {
  const messages = [{ role: 'user' as const, content: 'who at Acme has a phone?' }]

  it('runs the tool with validated input, sends all results in one user turn, returns final text + leads', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(msg('tool_use', [text('Looking.'), toolUse('t1', { q: 'Acme', has_phone: true, limit: 50 }), toolUse('t2', { bogus: 1 })]))
      .mockResolvedValueOnce(msg('end_turn', [text('Found 2 at Acme.')]))
    const search = vi.fn(async () => ({ rows: [lead('1'), lead('2')], total: 2 }))
    const out = await runPortalAgent({ client: { messages: { create } }, user, messages, search })

    expect(out).toEqual({ reply: 'Found 2 at Acme.', leads: [lead('1'), lead('2')] })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith({ q: 'Acme', region: undefined, has_phone: true, tab: 'email', page: 1, pageSize: 20 })

    const first = create.mock.calls[0][0]
    expect(first).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 2048, output_config: { effort: 'low' }, tool_choice: { type: 'auto' } })
    expect(first).not.toHaveProperty('thinking')
    expect(first.tools).toEqual([SEARCH_LEADS_TOOL])
    expect(first.system).toContain("Kaspen's team")

    const second = create.mock.calls[1][0].messages
    expect(second).toHaveLength(3)
    expect(second[2].role).toBe('user')
    const results = second[2].content
    expect(results.map((r: { tool_use_id: string }) => r.tool_use_id)).toEqual(['t1', 't2'])
    expect(results[1].is_error).toBe(true)
    expect(JSON.parse(results[0].content)).toMatchObject({ total_matches: 2, returned: 2 })
    expect(results[0].content).not.toContain('"id"')
  })

  it('stops after max iterations when the model keeps calling tools', async () => {
    const create = vi.fn(async () => msg('tool_use', [toolUse('t', { q: 'x' })]))
    const search = vi.fn(async () => ({ rows: [lead('9')], total: 1 }))
    const out = await runPortalAgent({ client: { messages: { create } }, user, messages, search })
    expect(create).toHaveBeenCalledTimes(PORTAL_AGENT_MAX_ITERATIONS)
    expect(out).toEqual({ reply: INCOMPLETE_REPLY, leads: [lead('9')] })
  })

  it('refusal → fixed polite reply; max_tokens → stops with what it has', async () => {
    const search = vi.fn()
    const refuse = vi.fn(async () => msg('refusal', []))
    expect(await runPortalAgent({ client: { messages: { create: refuse } }, user, messages, search })).toEqual({ reply: REFUSAL_REPLY, leads: [] })
    const cut = vi.fn(async () => msg('max_tokens', [text('Partial'), toolUse('t', { q: 'x' })]))
    expect(await runPortalAgent({ client: { messages: { create: cut } }, user, messages, search })).toEqual({ reply: 'Partial', leads: [] })
    expect(cut).toHaveBeenCalledTimes(1)
    expect(search).not.toHaveBeenCalled()
  })

  it('a failing search becomes an error tool_result, not a crash', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(msg('tool_use', [toolUse('t1', {})]))
      .mockResolvedValueOnce(msg('end_turn', [text('Search is down.')]))
    const search = vi.fn(async () => {
      throw new Error('db')
    })
    const out = await runPortalAgent({ client: { messages: { create } }, user, messages, search })
    expect(out.reply).toBe('Search is down.')
    expect(create.mock.calls[1][0].messages[2].content[0]).toMatchObject({ is_error: true })
  })
})
