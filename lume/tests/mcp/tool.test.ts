import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AuditEntry } from '@/lib/mcp/audit'
import { McpUserError } from '@/lib/mcp/sanitize'
import { defineTool, READ_ONLY, runTool, type ToolDeps } from '@/lib/mcp/tool'

function deps(count = 0) {
  const audits: AuditEntry[] = []
  const d: ToolDeps = { audit: vi.fn(async (e: AuditEntry) => void audits.push(e)), count: vi.fn(async () => count), now: () => new Date() }
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
