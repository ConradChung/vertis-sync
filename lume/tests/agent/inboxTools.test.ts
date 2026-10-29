import { describe, expect, it, vi } from 'vitest'
import { ALWAYS_ASK_KINDS, SKIPPABLE_KINDS, TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools, type ToolDeps } from '@/lib/agent/tools'

const CID = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'

function setup(body: unknown = { ok: true }, extra: Partial<ToolDeps> = {}) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body)))
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

describe('inbox tool tiers', () => {
  it('list_replies / get_thread read, label_reply low, send_reply still high and always asks', () => {
    expect(TOOL_TIERS.list_replies).toBe('read')
    expect(TOOL_TIERS.get_thread).toBe('read')
    expect(TOOL_TIERS.label_reply).toBe('low')
    expect(TOOL_TIERS.send_reply).toBe('high')
    expect(ALWAYS_ASK_KINDS.has('send_reply')).toBe(true)
    expect(SKIPPABLE_KINDS.has('send_reply')).toBe(false)
  })
})

describe('list_replies', () => {
  it('reads /api/inbox/replies with the filters', async () => {
    const { fetch, run } = setup({ configured: true, replies: [], next: null })
    await run('list_replies', { campaign_id: CID, unread: true, interest: 'interested', limit: 20 })
    expect(fetch.mock.calls[0][0]).toBe(`https://lume.test/api/inbox/replies?campaign_id=${CID}&unread=true&interest=interested&limit=20`)
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer s')
  })
  it('no filters: just the route', async () => {
    const { fetch, run } = setup({ configured: true, replies: [] })
    await run('list_replies', {})
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/inbox/replies')
  })
  it('refuses an unknown interest name; not configured is a clear error', async () => {
    const { tool } = setup()
    expect(() => tool('list_replies').inputSchema.parse({ interest: 'maybe' })).toThrow()
    const { run } = setup({ configured: false })
    await expect(run('list_replies', {})).rejects.toThrow(/not configured/)
  })
})

describe('get_thread', () => {
  it('by reply_to_uuid or thread_id (exactly one)', async () => {
    const { fetch, run, tool } = setup({ configured: true, thread: { messages: [] } })
    await run('get_thread', { reply_to_uuid: '01a15496-15cc-7596-adbf-b4a18d6b24ee' })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/inbox/thread?reply_to_uuid=01a15496-15cc-7596-adbf-b4a18d6b24ee')
    await run('get_thread', { thread_id: '86-IKbErTDOuLvKlLxyzN8vxZa' })
    expect(fetch.mock.calls[1][0]).toBe('https://lume.test/api/inbox/thread?thread_id=86-IKbErTDOuLvKlLxyzN8vxZa')
    expect(() => tool('get_thread').inputSchema.parse({})).toThrow()
    expect(() => tool('get_thread').inputSchema.parse({ reply_to_uuid: 'a', thread_id: 'b' })).toThrow()
  })
})

describe('label_reply', () => {
  it('posts the label to /api/inbox/label and creates no pending action', async () => {
    const { fetch, run, createAction } = setup({ ok: true, interest: 1 })
    await run('label_reply', { reply_to_uuid: 'e1', category: 'interested', verdict: 'GOOD' })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/inbox/label')
    expect(fetch.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ reply_to_uuid: 'e1', category: 'interested', verdict: 'GOOD' })
    expect(createAction).not.toHaveBeenCalled()
  })
  it('needs a category, or a BAD verdict; and a reply id or lead + campaign', () => {
    const s = setup().tool('label_reply').inputSchema
    expect(() => s.parse({ reply_to_uuid: 'e1' })).toThrow()
    expect(() => s.parse({ reply_to_uuid: 'e1', verdict: 'GOOD' })).toThrow()
    expect(s.parse({ reply_to_uuid: 'e1', verdict: 'BAD', block: true })).toBeTruthy()
    expect(() => s.parse({ category: 'ooo' })).toThrow()
    expect(s.parse({ lead_email: 'a@b.co', campaign_id: CID, category: 'ooo' })).toBeTruthy()
    expect(() => s.parse({ reply_to_uuid: 'e1', category: 'maybe' })).toThrow()
  })
})
