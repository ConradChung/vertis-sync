import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import type { AgentTool, ToolResult } from '@/lib/agent/tools'
import type { ToolTier } from '@/lib/agent/permissions'

/** What the run route hears about each call (SSE + `agent_runs.tool_calls`). */
export interface ToolHooks {
  onStart: (e: { id: string; name: string; tier: ToolTier; input: unknown }) => void | Promise<void>
  onEnd: (e: {
    id: string
    name: string
    tier: ToolTier
    ok: boolean
    result?: ToolResult
    error?: string
    ms: number
  }) => void | Promise<void>
}

/** Tool results go back to the model as JSON text, capped so one big list cannot flood the context. */
export const MAX_RESULT_CHARS = 24_000

export function resultText(result: ToolResult): string {
  const text = JSON.stringify(result)
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated ${text.length - MAX_RESULT_CHARS} chars; ask for a narrower query]`
    : text
}

/**
 * Wrap Lume's tiered tools as SDK runnable tools. `betaZodTool` validates
 * each input against the zod schema before `run` (needed with eager input
 * streaming, where the API no longer validates). Errors are rethrown so the
 * runner returns them to the model as an error `tool_result`.
 */
export function toRunnableTools(tools: AgentTool[], hooks: ToolHooks): BetaRunnableTool[] {
  return tools.map((tool) => ({
    ...betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      run: async (input, context) => {
        const id = context?.toolUse.id ?? `${tool.name}-${Date.now()}`
        const started = Date.now()
        await hooks.onStart({ id, name: tool.name, tier: tool.tier, input })
        try {
          const result = await tool.run(input)
          await hooks.onEnd({ id, name: tool.name, tier: tool.tier, ok: true, result, ms: Date.now() - started })
          return resultText(result)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          await hooks.onEnd({ id, name: tool.name, tier: tool.tier, ok: false, error, ms: Date.now() - started })
          throw err
        }
      },
    }),
    eager_input_streaming: true,
  }))
}
