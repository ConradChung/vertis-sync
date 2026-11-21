/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

// No DB in this test: list + auth only. Tool bodies are covered elsewhere.
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))

import { buildMcpHandler, allTools } from '@/lib/mcp/server'
import { checkMcpAuth } from '@/lib/mcp/auth'

const TOKEN = 't'.repeat(40)

async function rpc(body: unknown, auth = `Bearer ${TOKEN}`) {
  const handler = buildMcpHandler()
  const req = new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify(body),
  })
  const denied = checkMcpAuth(req, TOKEN)
  if (denied) return denied
  return handler(req)
}

async function json(res: Response): Promise<Record<string, any>> {
  const text = await res.text()
  const data = text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop()!
    : text
  return JSON.parse(data)
}

describe('MCP handler', () => {
  it('401s without the token', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '')
    expect(res.status).toBe(401)
  })

  it('lists every phase-1 tool, all read-only, all lume_ prefixed', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(res.status).toBe(200)
    const body = await json(res)
    const tools = body.result.tools as { name: string; annotations: Record<string, boolean>; inputSchema: unknown }[]
    expect(tools.map((t) => t.name).sort()).toEqual(allTools().map((t) => t.name).sort())
    expect(tools).toHaveLength(22)
    for (const t of tools) {
      expect(t.name).toMatch(/^lume_[a-z]+_[a-z_]+$/)
      expect(t.annotations.readOnlyHint).toBe(true)
      expect(t.annotations.destructiveHint).toBe(false)
      expect(t.inputSchema).toBeTruthy()
    }
  })

  it('a failing tool returns a short error, not internals', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lume_get_overview', arguments: {} } })
    const body = await json(res)
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/no db in tests|stack|node_modules/)
    expect(body.result?.isError).toBe(true)
    spy.mockRestore()
  })
})
