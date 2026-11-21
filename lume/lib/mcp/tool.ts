import type { McpServer, ToolAnnotations, CallToolResult } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { auditToEvents, type AuditSink } from './audit'
import { tableStore, withIdempotency, type IdemStore } from './idempotency'
import { checkLimit, countFromEvents, type CallClass, type CallCounter } from './limits'
import { McpUserError, redact, safeErrorMessage, truncate } from './sanitize'

/** Results larger than this are clipped; pagination keeps real ones well under. */
export const MAX_RESULT_CHARS = 60_000

export type ToolOutput = { data: unknown; refs?: Record<string, string> }

export type ToolDef<S extends z.ZodObject = z.ZodObject> = {
  name: `lume_${string}`
  title: string
  /** Includes the side effects, stated plainly. */
  description: string
  cls: CallClass
  input: S
  annotations: ToolAnnotations
  run: (args: z.infer<S>) => Promise<ToolOutput>
}

export type ToolDeps = { audit: AuditSink; count: CallCounter; now: () => Date; idem: IdemStore }

export const defaultDeps: ToolDeps = { audit: auditToEvents, count: countFromEvents, now: () => new Date(), idem: tableStore }

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def
}

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) }
}

/**
 * Wraps a tool body with the shared rules, in order: rate limit, run,
 * redact + clip the result, write one audit row. The audit write never
 * changes what the caller gets back; a failed write is logged.
 */
export async function runTool<S extends z.ZodObject>(
  def: ToolDef<S>,
  args: z.infer<S>,
  deps: ToolDeps = defaultDeps,
): Promise<CallToolResult> {
  const started = deps.now().getTime()
  const finish = async (
    outcome: 'ok' | 'error' | 'rate_limited',
    result: CallToolResult,
    extra: { error?: string; refs?: Record<string, string> } = {},
  ) => {
    try {
      await deps.audit({ tool: def.name, cls: def.cls, args, outcome, ms: deps.now().getTime() - started, ...extra })
    } catch (err) {
      console.error('[mcp] audit write failed', def.name, err instanceof Error ? err.name : 'unknown')
    }
    return result
  }

  const limit = await checkLimit(def.cls, deps.count, deps.now())
  if (!limit.ok) return finish('rate_limited', text(limit.message, true), { error: limit.message })

  try {
    // Writes honour idempotency_key: a repeat returns the first result and writes nothing.
    const out =
      def.cls === 'write'
        ? await withIdempotency(def.name, args as Record<string, unknown>, () => def.run(args), deps.idem)
        : await def.run(args)
    const body = truncate(redact(JSON.stringify(out.data)), MAX_RESULT_CHARS)
    return finish('ok', text(body), { refs: out.refs })
  } catch (err) {
    const message = safeErrorMessage(err)
    if (!(err instanceof McpUserError)) {
      console.error('[mcp] tool failed', def.name, err instanceof Error ? redact(err.message).slice(0, 200) : 'unknown')
    }
    return finish('error', text(message, true), { error: message })
  }
}

export function registerTools(server: McpServer, defs: ToolDef[], deps: ToolDeps = defaultDeps): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.input, annotations: def.annotations },
      (args: unknown) => runTool(def, args as z.infer<typeof def.input>, deps),
    )
  }
}

/** Annotations every read tool carries. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

/** Group B: changes Lume's own rows only (no outreach, no spend). Repeats are safe. */
export const INTERNAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

/** Group B writes that add a new row each call (notes, tasks, lists, drafts) unless an idempotency_key is reused. */
export const INTERNAL_APPEND: ToolAnnotations = { ...INTERNAL_WRITE, idempotentHint: false }
