/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))
import { mcpWriteMode } from '@/lib/mcp/config'
import { allTools, buildMcpHandler } from '@/lib/mcp/server'

async function listTools(mode: 'off' | 'internal' | 'gated') {
  const res = await buildMcpHandler(allTools(mode))(new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }))
  const text = await res.text()
  const data = text.includes('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).pop()!.slice(5) : text
  return (JSON.parse(data).result.tools as any[])
}

describe('write switch (LUME_MCP_WRITES)', () => {
  it('is off unless set to internal or gated', () => {
    expect(mcpWriteMode({})).toBe('off')
    expect(mcpWriteMode({ LUME_MCP_WRITES: '' })).toBe('off')
    expect(mcpWriteMode({ LUME_MCP_WRITES: 'true' })).toBe('off')
    expect(mcpWriteMode({ LUME_MCP_WRITES: '1' })).toBe('off')
    expect(mcpWriteMode({ LUME_MCP_WRITES: ' Internal ' })).toBe('internal')
    expect(mcpWriteMode({ LUME_MCP_WRITES: 'gated' })).toBe('gated')
  })

  it('off: tools/list has only the 22 read tools', async () => {
    const tools = await listTools('off')
    expect(tools).toHaveLength(22)
    expect(tools.every((t) => t.annotations.readOnlyHint === true)).toBe(true)
  })

  it('internal: read tools plus the 7 group B tools', async () => {
    const tools = await listTools('internal')
    expect(tools).toHaveLength(29)
    expect(tools.filter((t) => t.annotations.readOnlyHint === false).map((t) => t.name).sort()).toHaveLength(7)
  })

  it('gated: + the 15 group C tools; read helpers stay read-only', async () => {
    const tools = await listTools('gated')
    expect(tools).toHaveLength(44)
    const c = tools.filter((t) => t.name.startsWith('lume_') && !allTools('internal').some((x) => x.name === t.name))
    expect(c).toHaveLength(15)
    expect(c.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual(['lume_get_campaign_sequence', 'lume_suggest_campaign_setup'])
  })

  it('defaults to the env and the env defaults to off', () => {
    vi.stubEnv('LUME_MCP_WRITES', '')
    expect(allTools()).toHaveLength(22)
    vi.unstubAllEnvs()
  })
})
