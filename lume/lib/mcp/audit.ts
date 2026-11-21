import { logEvent } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import type { CallClass } from './limits'
import { sanitizeArgs } from './sanitize'

export type AuditOutcome = 'ok' | 'error' | 'rate_limited'

export type AuditEntry = {
  tool: string
  cls: CallClass
  args: unknown
  outcome: AuditOutcome
  ms: number
  /** Short, already-safe message for failed calls. */
  error?: string
  /** Ids worth finding later (action id, campaign id). Never lead lists. */
  refs?: Record<string, string>
}

export type AuditSink = (entry: AuditEntry) => Promise<void>

/** One `events` row per tool call: type mcp.tool_call, source mcp, sanitised args. */
export const auditToEvents: AuditSink = async (e) => {
  const payload = {
    tool: e.tool,
    class: e.cls,
    outcome: e.outcome,
    ms: e.ms,
    args: sanitizeArgs(e.args) as Json,
    ...(e.error ? { error: e.error } : {}),
    ...(e.refs ? { refs: e.refs } : {}),
  }
  await logEvent({
    type: 'mcp.tool_call',
    source: 'mcp',
    title: `${e.tool} · ${e.outcome}`,
    payload: payload as Record<string, Json>,
  })
}
