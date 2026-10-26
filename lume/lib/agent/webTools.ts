import type { ToolHooks } from '@/lib/agent/runnable'

/** Server-side web tools: search plus page fetch for research (ICPs, company sites). */
export const WEB_TOOLS = [
  { type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: 8 },
  { type: 'web_fetch_20260209' as const, name: 'web_fetch' as const, max_uses: 10 },
]

type ContentBlock = { type: string; id?: string; tool_use_id?: string; name?: string; input?: unknown; content?: unknown }

/** Mirror server-side web tool calls into the tool log (they run on Anthropic's side, so no runnable hooks fire). */
export async function logServerToolUses(content: readonly unknown[], hooks: ToolHooks) {
  const blocks = content as ContentBlock[]
  for (const b of blocks) {
    if (b.type !== 'server_tool_use' || !b.id || (b.name !== 'web_search' && b.name !== 'web_fetch')) continue
    const result = blocks.find((r) => r.tool_use_id === b.id && r.type.endsWith('_tool_result'))
    const c = result?.content as { type?: string; error_code?: string } | undefined
    const failed = !result || (c && !Array.isArray(c) && typeof c.type === 'string' && c.type.endsWith('_error'))
    await hooks.onStart({ id: b.id, name: b.name, tier: 'read', input: b.input })
    await hooks.onEnd({ id: b.id, name: b.name, tier: 'read', ok: !failed, ms: 0, ...(failed ? { error: c?.error_code ?? 'no result' } : {}) })
  }
}
