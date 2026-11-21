import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AuditEntry } from '@/lib/mcp/audit'
import { McpUserError } from '@/lib/mcp/sanitize'
import { defineTool, READ_ONLY, runTool, type ToolDeps } from '@/lib/mcp/tool'

function deps(count = 0) {
  const audits: AuditEntry[] = []
  const d: ToolDeps = { audit: vi.fn(async (e: AuditEntry) => void audits.push(e)), count: vi.fn(async () => count), now: () => new Date(), idem: { get: async () => null, put: async () => true } }
  return { d, audits }
}

const tool = (run: () => Promise<{ data: unknown }>) =>
  defineTool({ name: 'lume_test', title: 't', description: 'd', cls: 'read', input: z.object({ q: z.string().optional() }), annotations: READ_ONLY, run })

describe('runTool', () => {
  it('returns JSON text and writes one audit row', async () => {
    const { d, audits } = deps()
    const res = await runTool(tool(async () => ({ data: { n: 1 } })), { q: 'x' }, d)
    expect(res.isError).toBeUndefined()
    expect(res.content[0]).toEqual({ type: 'text', text: '{"n":1}' })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ tool: 'lume_test', cls: 'read', outcome: 'ok', args: { q: 'x' } })
  })

  it('redacts secrets that slip into a result', async () => {
    process.env.TEST_MCP_SECRET_KEY = 'super-secret-value-123456'
    const { d } = deps()
    const res = await runTool(tool(async () => ({ data: { leak: 'super-secret-value-123456' } })), {}, d)
    expect(JSON.stringify(res)).not.toContain('super-secret-value-123456')
    delete process.env.TEST_MCP_SECRET_KEY
  })

  it('refuses over the rate limit, runs nothing, audits it', async () => {
    const { d, audits } = deps(1000)
    const run = vi.fn(async () => ({ data: 1 }))
    const res = await runTool(tool(run), {}, d)
    expect(res.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
    expect(audits[0].outcome).toBe('rate_limited')
  })

  it('shows user errors, hides internal ones', async () => {
    const { d, audits } = deps()
    const user = await runTool(tool(async () => { throw new McpUserError('No deal with id 1.') }), {}, d)
    expect(user.content[0]).toMatchObject({ text: 'No deal with id 1.' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const internal = await runTool(tool(async () => { throw new Error('pg: relation x at /var/task/a.js') }), {}, d)
    expect(JSON.stringify(internal)).not.toMatch(/relation|var\/task/)
    expect(audits.map((a) => a.outcome)).toEqual(['error', 'error'])
    spy.mockRestore()
  })

  it('still answers when the audit write fails', async () => {
    const { d } = deps()
    d.audit = async () => { throw new Error('events insert failed') }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runTool(tool(async () => ({ data: 'ok' })), {}, d)
    expect(res.content[0]).toMatchObject({ text: '"ok"' })
    spy.mockRestore()
  })
})

describe('runTool idempotency for writes', () => {
  const rows = new Map<string, import('@/lib/mcp/idempotency').IdemRow>()
  const idem = { get: async (k: string) => rows.get(k) ?? null, put: async (r: import('@/lib/mcp/idempotency').IdemRow) => (rows.set(r.key, r), true) }
  const write = (run: () => Promise<{ data: unknown }>, cls: 'write' | 'read' = 'write') =>
    defineTool({ name: 'lume_test_write', title: 't', description: 'd', cls, input: z.object({ a: z.number(), idempotency_key: z.string().optional() }), annotations: READ_ONLY, run })

  it('a write repeated with the same key runs once and is audited twice', async () => {
    const { d, audits } = deps()
    d.idem = idem
    const run = vi.fn(async () => ({ data: { id: 'x1' } }))
    const first = await runTool(write(run), { a: 1, idempotency_key: 'retry-0001' }, d)
    const second = await runTool(write(run), { a: 1, idempotency_key: 'retry-0001' }, d)
    expect(run).toHaveBeenCalledTimes(1)
    expect(first.content[0]).toEqual({ type: 'text', text: '{"id":"x1"}' })
    expect(second.content[0]).toEqual({ type: 'text', text: '{"id":"x1","replayed":true}' })
    expect(audits.map((a) => a.outcome)).toEqual(['ok', 'ok'])
    const { sanitizeArgs } = await import('@/lib/mcp/sanitize')
    expect(sanitizeArgs(audits[0].args as Record<string, unknown>)).toEqual({ a: 1, idempotency_key: '[omitted]' }) // stored audit masks *key* fields
  })

  it('reads never touch the idempotency store', async () => {
    const { d } = deps()
    const get = vi.fn(async () => null)
    d.idem = { get, put: vi.fn(async () => true) }
    await runTool(write(async () => ({ data: {} }), 'read'), { a: 1, idempotency_key: 'retry-0002' }, d)
    expect(get).not.toHaveBeenCalled()
  })
})
