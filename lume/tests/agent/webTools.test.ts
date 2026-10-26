import { describe, expect, it, vi } from 'vitest'
import { WEB_TOOLS, logServerToolUses } from '@/lib/agent/webTools'

describe('web tools', () => {
  it('declares search and fetch server tools with caps', () => {
    expect(WEB_TOOLS.map((t) => t.type)).toEqual(['web_search_20260209', 'web_fetch_20260209'])
    expect(WEB_TOOLS.every((t) => t.max_uses > 0)).toBe(true)
  })

  it('mirrors server tool uses into the tool log', async () => {
    const hooks = { onStart: vi.fn(), onEnd: vi.fn() }
    await logServerToolUses(
      [
        { type: 'text', text: 'x' },
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'acme icp' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://a' }] },
        { type: 'server_tool_use', id: 's2', name: 'web_fetch', input: { url: 'https://acme.com' } },
        { type: 'web_fetch_tool_result', tool_use_id: 's2', content: { type: 'web_fetch_tool_error', error_code: 'url_not_accessible' } },
      ],
      hooks
    )
    expect(hooks.onStart).toHaveBeenCalledTimes(2)
    expect(hooks.onEnd).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 's1', ok: true, tier: 'read' }))
    expect(hooks.onEnd).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 's2', ok: false, error: 'url_not_accessible' }))
  })
})
