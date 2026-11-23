/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

// No DB: tools/list only.
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))

import { allTools, buildMcpHandler } from '@/lib/mcp/server'

async function listTools() {
  const handler = buildMcpHandler(allTools('gated'))
  const res = await handler(new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }))
  const text = await res.text()
  const data = text.includes('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop()! : text
  return JSON.parse(data).result.tools as { name: string; description: string; inputSchema: any }[]
}

describe('lume_run_influencer_scrape in tools/list', () => {
  it('publishes post_url (string) and post_urls (array or string) so clients can target posts', async () => {
    const tool = (await listTools()).find((t) => t.name === 'lume_run_influencer_scrape')!
    expect(tool).toBeTruthy()
    const props = tool.inputSchema.properties
    expect(props.post_url.type).toBe('string')
    const variants = (props.post_urls.anyOf ?? props.post_urls.oneOf) as { type: string }[]
    expect(variants.map((v) => v.type).sort()).toEqual(['array', 'string'])
    expect(tool.inputSchema.required).toEqual(['slugs'])
    expect(tool.description).toMatch(/post_url/)
  })
})
