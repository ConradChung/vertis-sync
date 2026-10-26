import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction } from '@/lib/actions/create'
import { sendMessage } from '@/lib/adapters/telegram'
import { SYSTEM_PROMPT } from '@/lib/agent/prompt'
import { toRunnableTools, type ToolHooks } from '@/lib/agent/runnable'
import { insertAgentRun, updateAgentRun, type AgentRunPatch } from '@/lib/agent/runs'
import { buildTools } from '@/lib/agent/tools'
import type { ToolCallEntry } from '@/lib/agent/orbState'
import { logEvent } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * POST `{ prompt }` → the orb agent, streamed as Server-Sent Events.
 *
 * One `agent_runs` row per call (Realtime drives the orb). The SDK Tool
 * Runner loops over Lume's tiered tools; read/low tools call Lume's own
 * routes with the internal bearer, high-risk tools only create a pending
 * action. Each call is appended to `agent_runs.tool_calls` (status running
 * → ok/error); a high-risk result sets `status='needs_approval'` and
 * `approval_action_id`. Finish → `done` (or stays `needs_approval`) /
 * `failed`, with `usage` and the final text as `outcome`.
 *
 * SSE events (`data: <json>\n\n`): run, text, tool_start, tool_end,
 * approval, done, error.
 *
 * 503 `agent_not_configured` when `ANTHROPIC_API_KEY` is unset.
 */

export const maxDuration = 300
export const runtime = 'nodejs'

const MODEL = 'claude-opus-5-5'

const Body = z.object({ prompt: z.string().trim().min(1).max(4000) })

type SseEvent = Record<string, unknown> & { type: string }

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'agent_not_configured', message: 'The agent is not configured: ANTHROPIC_API_KEY is not set.' },
      { status: 503 }
    )
  }

  const body = await parseJsonBody(req, Body, 16 * 1024)
  if (!body.ok) return body.response
  const prompt = body.data.prompt

  let runId: string
  try {
    runId = (await insertAgentRun(prompt, MODEL)).id
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/run')
  }

  const origin = process.env.LUME_URL || new URL(req.url).origin
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (e: SseEvent) => {
        if (closed) return
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
        } catch {
          closed = true
        }
      }
      send({ type: 'run', id: runId })
      await executeRun({ runId, prompt, origin, send })
      if (!closed) {
        closed = true
        controller.close()
      }
    },
    cancel() {
      // The browser went away; the run still finishes and records itself.
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

async function executeRun({
  runId,
  prompt,
  origin,
  send,
}: {
  runId: string
  prompt: string
  origin: string
  send: (e: SseEvent) => void
}): Promise<void> {
  const toolCalls: ToolCallEntry[] = []
  let approvalActionId: string | null = null
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  // Writes are chained so `tool_calls` snapshots land in order.
  let writes: Promise<void> = Promise.resolve()
  const save = (patch: AgentRunPatch) => {
    writes = writes
      .then(() => updateAgentRun(runId, patch))
      .catch((err) => console.error('[api/agent/run] update failed:', err instanceof Error ? err.message : err))
    return writes
  }
  const snapshot = () => toolCalls.map((c) => ({ ...c })) as unknown as Json[]

  const hooks: ToolHooks = {
    onStart: async ({ id, name, tier, input }) => {
      toolCalls.push({ id, name, tier, input, status: 'running' })
      send({ type: 'tool_start', id, name, tier, input })
      await save({ tool_calls: snapshot() })
    },
    onEnd: async ({ id, name, tier, ok, result, error, ms }) => {
      const entry = toolCalls.find((c) => c.id === id)
      if (entry) Object.assign(entry, { status: ok ? 'ok' : 'error', ms, ...(error ? { error } : {}) })
      send({ type: 'tool_end', id, name, tier, ok, ms, ...(error ? { error } : {}) })
      if (ok && result?.status === 'awaiting_approval' && typeof result.action_id === 'string' && result.action_id) {
        approvalActionId = result.action_id
        if (entry) entry.action_id = result.action_id
        send({ type: 'approval', action_id: result.action_id, deep_link: result.deep_link, summary: result.summary ?? null, tool: name })
        await save({ status: 'needs_approval', approval_action_id: approvalActionId, tool_calls: snapshot() })
        return
      }
      await save({ tool_calls: snapshot() })
    },
  }

  const tools = toRunnableTools(
    buildTools({
      fetch: (url, init) => fetch(url, init),
      createAction: (kind, payload, requestedBy, meta) => createAction(kind, payload, requestedBy, meta),
      prepare: (request) => buildActionRequest(request),
      agentRunId: runId,
      baseUrl: origin,
      notify: async (text) => {
        const r = await sendMessage(text, { disablePreview: true })
        return r.ok ? { ok: true } : { ok: false, error: 'error' in r ? String(r.error) : 'not sent' }
      },
    }),
    hooks
  )

  let outcome = ''
  let status: 'done' | 'needs_approval' | 'failed' = 'done'
  try {
    const client = new Anthropic()
    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM_PROMPT,
      tools,
      messages: [{ role: 'user', content: prompt }],
      max_iterations: 20,
      stream: true,
      // Server-side fallback on a safety-classifier refusal (routes by category).
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })

    let turn = 0
    for await (const messageStream of runner) {
      if (turn++ > 0) send({ type: 'text', delta: '\n\n' })
      messageStream.on('text', (delta) => send({ type: 'text', delta }))
      const message = await messageStream.finalMessage()
      usage.input_tokens += message.usage.input_tokens ?? 0
      usage.output_tokens += message.usage.output_tokens ?? 0
      usage.cache_read_input_tokens += message.usage.cache_read_input_tokens ?? 0
      usage.cache_creation_input_tokens += message.usage.cache_creation_input_tokens ?? 0
      const text = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (text) outcome = text
      if (message.stop_reason === 'refusal') {
        status = 'failed'
        outcome = outcome || 'The model declined this request.'
        break
      }
    }
    if (status !== 'failed') status = approvalActionId ? 'needs_approval' : 'done'
  } catch (err) {
    status = 'failed'
    outcome = err instanceof Anthropic.APIError ? `Claude API error ${err.status ?? ''}: ${err.message}` : err instanceof Error ? err.message : String(err)
    console.error('[api/agent/run] run failed:', outcome)
    send({ type: 'error', message: outcome })
  }

  await save({
    status,
    outcome: outcome.slice(0, 8000),
    usage: usage as unknown as Record<string, Json>,
    finished_at: new Date().toISOString(),
    tool_calls: snapshot(),
    ...(approvalActionId ? { approval_action_id: approvalActionId } : {}),
  })
  try {
    await logEvent({
      type: 'agent.run',
      source: 'lume',
      source_id: runId,
      title: prompt.slice(0, 120),
      payload: { status, tools: toolCalls.length, approval_action_id: approvalActionId },
    })
  } catch (err) {
    console.error('[api/agent/run] logEvent failed:', err instanceof Error ? err.message : err)
  }
  send({ type: 'done', id: runId, status, usage, approval_action_id: approvalActionId })
}
