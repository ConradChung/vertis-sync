import { AsyncLocalStorage } from 'node:async_hooks'

/** Per-request facts a tool may need but the MCP SDK does not pass: where this deployment calls itself. */
export type McpRequestContext = { origin: string | null }

export const mcpContext = new AsyncLocalStorage<McpRequestContext>()

/** The internal origin for server-to-server calls (the execute hand-off), or null outside a request. */
export function mcpOrigin(): string | null {
  return mcpContext.getStore()?.origin ?? null
}
