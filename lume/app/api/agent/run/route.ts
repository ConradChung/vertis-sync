import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction } from '@/lib/actions/create'
import { sendMessage } from '@/lib/adapters/telegram'
import { buildPrompt } from '@/lib/agent/chat'
import { createConversation, getConversation, getMessages, insertMessage } from '@/lib/agent/conversations'
import { contextFromMessages, titleFromPrompt, type StoredApproval, type StoredToolEntry } from '@/lib/agent/history'
import { SYSTEM_PROMPT } from '@/lib/agent/prompt'
import { skillContext } from '@/lib/agent/skillModel'
import { createSkill, findSkillByName, getSkill, listSkills, markSkillRun } from '@/lib/agent/skills'
import { toRunnableTools, type ToolHooks } from '@/lib/agent/runnable'
import { failStaleRuns, insertAgentRun, updateAgentRun, type AgentRunPatch } from '@/lib/agent/runs'
import { buildTools } from '@/lib/agent/tools'
import { WEB_TOOLS, logServerToolUses } from '@/lib/agent/webTools'
import { STALE_RUN_MS, type ToolCallEntry } from '@/lib/agent/orbState'
import { logEvent } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, UUID_RE } from '@/lib/http/json'
import { internalOrigin } from '@/lib/http/origin'

/**
 * POST `{ prompt, conversation_id? }` → the agent, streamed as Server-Sent Events.
 *
 * Chat history: without `conversation_id` a new `agent_conversations` row is
 * created (titled from the prompt); with one (404 when missing or deleted),
 * that conversation's stored turns are packed ahead of the prompt as context
 * (`buildPrompt`) — the client never supplies history. The user message is
 * stored before the run, the assistant message (text, tools, approvals,
 * error) when it ends, server side, so a closed tab loses nothing.
 *
 * One `agent_runs` row per call (Realtime drives the orb). The SDK Tool
 * Runner loops over Lume's tiered tools; read/low tools call Lume's own
 * routes with the internal bearer, high-risk tools only create a pending
 * action. Each call is appended to `agent_runs.tool_calls` (status running
 * → ok/error); a high-risk result sets `status='needs_approval'` and
 * `approval_action_id`. Finish → `done` (or stays `needs_approval`) /
 * `failed`, with `usage` and the final text as `outcome`.
 *
 * Skills: `skill_id` + `skill_mode` ('run' | 'reference') load a saved skill
 * and put its steps ahead of the prompt (`skillContext`); 'run' also bumps
 * its run count. 404 `skill_not_found` when it is missing or deleted.
 *
 * SSE events (`data: <json>\n\n`): run (`{ id, conversation_id }`), text,
 * tool_start, tool_end, approval, done, error.
 *
 * 503 `agent_not_configured` when `ANTHROPIC_API_KEY` is unset.
 */

export const maxDuration = 300
export const runtime = 'nodejs'

/** Sonnet 5.5 at low effort: fast enough for chat, strong at tool use. Override with LUME_AGENT_MODEL. */
const MODEL = process.env.LUME_AGENT_MODEL?.trim() || 'claude-sonnet-5-5'

const Body = z.object({
  prompt: z.string().trim().min(1).max(4000),
  conversation_id: z.string().regex(UUID_RE).optional(),
  skill_id: z.string().regex(UUID_RE).optional(),
  skill_mode: z.enum(['run', 'reference']).optional(),
})

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
  const message = body.data.prompt

  // Runs left `running` by a killed function: close them so the orb and the
  // run log stop showing them as live. Best effort.
  try {
    await failStaleRuns(new Date(Date.now() - STALE_RUN_MS))
  } catch (err) {
    console.error('[api/agent/run] stale run cleanup failed:', err instanceof Error ? err.message : err)
  }

  let runId: string
  let conversationId: string
  let prompt = message
  const skillMode = body.data.skill_mode ?? 'reference'
  let skill: Awaited<ReturnType<typeof getSkill>> = null
  try {
    // Before any write, so a missing skill leaves no empty conversation behind.
    if (body.data.skill_id) {
      skill = await getSkill(body.data.skill_id.toLowerCase())
      if (!skill) return NextResponse.json({ error: 'skill_not_found' }, { status: 404 })
    }
    if (body.data.conversation_id) {
      const id = body.data.conversation_id.toLowerCase()
      const conversation = await getConversation(id)
      if (!conversation) return NextResponse.json({ error: 'conversation_not_found' }, { status: 404 })
      conversationId = conversation.id
      prompt = buildPrompt(contextFromMessages(await getMessages(conversationId)), message)
    } else {
      conversationId = (await createConversation(titleFromPrompt(message))).id
    }
    if (skill) {
      prompt = `${skillContext(skill, skillMode)}\n\n${prompt}`
      if (skillMode === 'run') await markSkillRun(skill.id)
    }
    runId = (await insertAgentRun(prompt, MODEL)).id
    await insertMessage({ conversation_id: conversationId, role: 'user', text: message, run_id: runId })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/run')
  }

  // Tool fetches stay on this deployment (LUME_INTERNAL_URL, else the request
  // origin): a local or preview run must never call production. LUME_URL is
  // for deep links only.
  const origin = internalOrigin(req)
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
      send({ type: 'run', id: runId, conversation_id: conversationId })
      const reply = await executeRun({ runId, prompt, title: message, origin, conversationId, send })
      try {
        await insertMessage({ conversation_id: conversationId, role: 'assistant', run_id: runId, ...reply })
      } catch (err) {
        console.error('[api/agent/run] storing the reply failed:', err instanceof Error ? err.message : err)
      }
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

/** What the run said and did, stored as the assistant message. */
interface RunReply {
  text: string
  tools: StoredToolEntry[]
  approvals: StoredApproval[]
  error: string | null
}

async function executeRun({
  runId,
  prompt,
  title,
  origin,
  conversationId,
  send: emit,
}: {
  runId: string
  prompt: string
  /** The owner's own words (the prompt may carry packed history). */
  title: string
  origin: string
  conversationId: string
  send: (e: SseEvent) => void
}): Promise<RunReply> {
  // Mirror what the browser shows, so a reloaded conversation looks the same.
  const reply: RunReply = { text: '', tools: [], approvals: [], error: null }
  const send = (e: SseEvent) => {
    if (e.type === 'text') reply.text += String(e.delta ?? '')
    else if (e.type === 'approval') {
      const a = { action_id: String(e.action_id), deep_link: String(e.deep_link ?? `/actions/${e.action_id}`), summary: (e.summary as string | null) ?? null, tool: String(e.tool ?? '') }
      reply.approvals = [...reply.approvals.filter((x) => x.action_id !== a.action_id), a]
    } else if (e.type === 'error') reply.error = String(e.message ?? 'The run failed.')
    emit(e)
  }
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
      conversationId,
      skills: { list: () => listSkills(), get: getSkill, findByName: findSkillByName, create: createSkill },
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
      output_config: { effort: 'low' },
      // Caches the stable system prompt + tool list across the run's turns and across runs.
      cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT,
      // Anthropic-hosted, read-only web research (no approval needed: nothing leaves Lume but a query/URL).
      tools: [...tools, ...WEB_TOOLS],
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
      await logServerToolUses(message.content, hooks)
      // The runner does not auto-resume a paused server-tool turn; push it back so the answer isn't truncated.
      if (message.stop_reason === 'pause_turn') {
        runner.pushMessages({ role: 'assistant', content: message.content })
        continue
      }
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
      title: title.slice(0, 120),
      payload: { status, tools: toolCalls.length, approval_action_id: approvalActionId },
    })
  } catch (err) {
    console.error('[api/agent/run] logEvent failed:', err instanceof Error ? err.message : err)
  }
  send({ type: 'done', id: runId, status, usage, approval_action_id: approvalActionId })
  reply.tools = toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    tier: c.tier,
    status: c.status === 'ok' && c.tier === 'high' ? 'awaiting' : c.status,
    ...(c.ms !== undefined ? { ms: c.ms } : {}),
    ...(c.error ? { error: c.error } : {}),
  }))
  if (status === 'failed' && !reply.error && !reply.text) reply.error = outcome || 'The run failed.'
  return reply
}
