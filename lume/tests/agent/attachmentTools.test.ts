import { describe, expect, it, vi } from 'vitest'
import { ALWAYS_ASK_KINDS, HIGH_RISK_KIND, SKIPPABLE_KINDS, TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools, type ToolDeps } from '@/lib/agent/tools'
import { REVIEW_TOOLS } from '@/lib/agent/chatDiagrams'

/** read_attachment, load_attachment_as_leads and stage_attachment_for_validation (deps injected, no network). */

const FILE = '0F3C2B1A-9D8E-4F7A-8B6C-5D4E3F2A1B0C'
const file = FILE.toLowerCase()
const CONV = '1a2b3c4d-1111-4222-8333-444455556666'

function setup(responses: Record<string, unknown> = {}, extra: Partial<ToolDeps> = {}) {
  const fetch = vi.fn(async (url: string) => {
    const path = url.replace('https://lume.test', '')
    const key = Object.keys(responses).find((k) => path.startsWith(k))
    return new Response(JSON.stringify(key ? responses[key] : { ok: true }), { status: 200 })
  })
  const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
  const prepare = vi.fn(async ({ kind, payload }: { kind: string; payload: Record<string, unknown> }) => ({ ok: true as const, kind, payload: { ...payload, summary: `built ${kind}` } }))
  const autoApprove = vi.fn()
  const tools = buildTools({ fetch: fetch as never, createAction, prepare: prepare as never, agentRunId: 'r1', baseUrl: 'https://lume.test', secret: 's', conversationId: CONV, ...extra, autoApprove })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const run = (name: string, input: unknown) => tool(name).run(tool(name).inputSchema.parse(input))
  return { fetch, createAction, prepare, autoApprove, tool, run }
}

describe('attachment tool tiers', () => {
  it('read, low and an always-ask approval', () => {
    expect(TOOL_TIERS.read_attachment).toBe('read')
    expect(TOOL_TIERS.load_attachment_as_leads).toBe('low')
    expect(TOOL_TIERS.stage_attachment_for_validation).toBe('high')
    expect(HIGH_RISK_KIND.stage_attachment_for_validation).toBe('stage_attachment')
    expect(ALWAYS_ASK_KINDS.has('stage_attachment')).toBe(true)
    expect(SKIPPABLE_KINDS.has('stage_attachment')).toBe(false)
    expect(REVIEW_TOOLS.has('load_attachment_as_leads')).toBe(true)
  })
})

describe('read_attachment', () => {
  it('pages the rows route, scoped to this conversation', async () => {
    const { run, fetch } = setup({ [`/api/agent/files/${file}/rows`]: { csv: 'a\n1', next_offset: null } })
    expect(await run('read_attachment', { file_id: FILE, sheet: 'Leads', offset: 100, limit: 200 })).toEqual({ csv: 'a\n1', next_offset: null })
    const url = new URL(fetch.mock.calls[0][0])
    expect(url.pathname).toBe(`/api/agent/files/${file}/rows`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ offset: '100', limit: '200', sheet: 'Leads', conversation: CONV })
  })
  it('defaults to the first page and refuses a limit over 500', async () => {
    const { run, fetch, tool } = setup()
    await run('read_attachment', { file_id: FILE })
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('limit')).toBe('100')
    expect(() => tool('read_attachment').inputSchema.parse({ file_id: FILE, limit: 501 })).toThrow()
  })
})

describe('load_attachment_as_leads', () => {
  it('creates a review set from the sheet with the column overrides and returns the mapping', async () => {
    const answer = { set: { id: 's1' }, column_mapping: { email: 'Work Email' }, unmapped_columns: ['Notes'] }
    const { run, fetch } = setup({ '/api/review-sets': answer })
    expect(await run('load_attachment_as_leads', { file_id: FILE, sheet: 'Leads', columns: { email: 'Work Email' }, title: 'Q3 list' })).toEqual(answer)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: string }]
    expect(url).toBe('https://lume.test/api/review-sets')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ source: { kind: 'attachment', id: file, sheet: 'Leads', columns: { email: 'Work Email' } }, conversation_id: CONV, title: 'Q3 list' })
  })
  it('only lead fields can be overridden', () => {
    const { tool } = setup()
    expect(() => tool('load_attachment_as_leads').inputSchema.parse({ file_id: FILE, columns: { salary: 'X' } })).toThrow()
  })
})

describe('stage_attachment_for_validation', () => {
  it('only files an approval (never runs), even in skip-permissions mode', async () => {
    const { run, prepare, createAction, autoApprove, fetch } = setup({}, { skipPermissions: true })
    const r = await run('stage_attachment_for_validation', { file_id: FILE, sheet: 'Leads' })
    // Scoped like the other two tools: the snapshot names this chat, the builder checks the file is attached in it.
    expect(prepare).toHaveBeenCalledWith({ kind: 'stage_attachment', payload: { file_id: file, sheet: 'Leads', conversation_id: CONV } })
    expect(createAction.mock.calls[0][0]).toBe('stage_attachment')
    expect(r).toMatchObject({ status: 'awaiting_approval', action_id: 'a1' })
    expect(autoApprove).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
