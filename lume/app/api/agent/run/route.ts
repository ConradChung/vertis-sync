import Anthropic from '@anthropic-ai/sdk'
import { maskKeyText } from '@/lib/operators/mask'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction } from '@/lib/actions/create'
import { executeAction } from '@/lib/actions/execute'
import { claimDecision, getAction } from '@/lib/actions/store'
import { editMessage, sendMessage } from '@/lib/adapters/telegram'
import { alert, alertLink, titleFrom } from '@/lib/alerts'
import { routeItemForAction } from '@/lib/operators/route'
import { buildPrompt } from '@/lib/agent/chat'
import { createConversation, getConversation, getMessages, insertMessage } from '@/lib/agent/conversations'
import { contextFromMessages, titleFromPrompt, type StoredApproval, type StoredToolEntry } from '@/lib/agent/history'
import { SYSTEM_PROMPT } from '@/lib/agent/prompt'
import { loadKnowledge } from '@/lib/agent/memory'
import { withKnowledge } from '@/lib/agent/memoryModel'
import { skillContext } from '@/lib/agent/skillModel'
import { createSkill, findSkillByName, getSkill, listSkills, markSkillRun } from '@/lib/agent/skills'
import { toRunnableTools, type ToolHooks } from '@/lib/agent/runnable'
import { failStaleRuns, insertAgentRun, updateAgentRun, type AgentRunPatch } from '@/lib/agent/runs'
import { buildTools, type ToolDeps } from '@/lib/agent/tools'
import { WEB_TOOLS, logServerToolUses } from '@/lib/agent/webTools'
import { STALE_RUN_MS, type ToolCallEntry } from '@/lib/agent/orbState'
import { logEvent } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, UUID_RE } from '@/lib/http/json'
import { internalOrigin } from '@/lib/http/origin'
import { operatorPromptLine, verticalPromptLine } from '@/lib/operators/context'
import { currentOperator } from '@/lib/operators/session'
import { getVertical } from '@/lib/operators/store'

/**
 * POST `{ prompt, conversation_id?, skip_permissions?, auto? }` → the agent,
 * streamed as Server-Sent Events.
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
 * Skip permissions (`skip_permissions: true`, per chat, sent by the client):
 * a skippable high-risk kind is still filed as a pending action, then claimed
 * at once (decided_via 'agent') and executed here; its approval event carries
 * `state: 'auto_executed' | 'auto_failed'` and the run does not wait. Always-ask
 * kinds (lib/agent/permissions.ts) wait as usual (`state: 'awaiting'`).
 * `auto: true` marks a client-sent automatic follow-up turn (an approval
 * outcome); it is stored on the user message.
 *
 * Skills: `skill_id` + `skill_mode` ('run' | 'reference') load a saved skill
 * and put its steps ahead of the prompt (`skillContext`); 'run' also bumps
 * its run count. 404 `skill_not_found` when it is missing or deleted.
 *
 * Grok Bot operators (a valid `lume_op` cookie on the owner session): a new
 * conversation stores the bot's `vertical_id` + `operator_id`, and every run's
 * prompt opens with a line naming the bot, its vertical's campaigns and its
 * full owner authority (`operatorPromptLine`).
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
  skip_permissions: z.boolean().optional(),
  auto: z.boolean().optional(),
  /** Owner only, new conversations only: tag the chat with this vertical (from /operator). */
  vertical_id: z.string().regex(UUID_RE).optional(),
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

  // A Grok Bot on the owner session; never the agent's internal bearer.
  const operator = auth.via === 'session' ? await currentOperator(req) : null

  let runId: string
  let conversationId: string
  let prompt = message
  let ownerVertical: Awaited<ReturnType<typeof getVertical>> = null
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
      const title = titleFromPrompt(message)
      if (!operator && body.data.vertical_id) ownerVertical = await getVertical(body.data.vertical_id.toLowerCase())
      const created = operator
        ? await createConversation(title, { vertical_id: operator.vertical_id, operator_id: operator.id })
        : ownerVertical
          ? await createConversation(title, { vertical_id: ownerVertical.id, operator_id: null })
          : await createConversation(title)
      conversationId = created.id
    }
    if (skill) {
      prompt = `${skillContext(skill, skillMode)}\n\n${prompt}`
      if (skillMode === 'run') await markSkillRun(skill.id)
    }
    if (operator) {
      const vertical = operator.vertical_id ? await getVertical(operator.vertical_id) : null
      prompt = `${operatorPromptLine(operator, vertical)}\n\n${prompt}`
    } else if (ownerVertical) {
      prompt = `${verticalPromptLine(ownerVertical)}\n\n${prompt}`
    }
    runId = (await insertAgentRun(prompt, MODEL)).id
    await insertMessage({ conversation_id: conversationId, role: 'user', text: message, run_id: runId, ...(body.data.auto ? { auto: true } : {}) })
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
      // Saved memories + recent chat titles ride in the user turn, so the system prompt stays cached.
      const knowledge = await loadKnowledge(conversationId).catch((err) => {
        console.error('[api/agent/run] memory load failed:', err instanceof Error ? err.message : err)
        return ''
      })
      const reply = await executeRun({
        runId,
        prompt: withKnowledge(knowledge, prompt),
        title: message,
        origin,
        conversationId,
        skipPermissions: body.data.skip_permissions === true,
        send,
      })
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

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Someone else claimed or ran it first: report where it stands. */
async function handledElsewhere(id: string, status?: string): Promise<Awaited<ReturnType<NonNullable<ToolDeps['autoApprove']>>>> {
  let current = status ?? null
  if (!current) {
    try {
      current = (await getAction(id))?.status ?? 'not_found'
    } catch (err) {
      console.error('[api/agent/run] getAction failed:', errText(err))
    }
  }
  return { status: 'handled_elsewhere', result: { status: current }, error: null }
}

/**
 * Skip mode's approval: the same claim a Lume click runs (decided_via
 * 'agent'), then the executor, server-side. The tool never reaches this
 * without the owner's per-chat opt-in and a skippable kind. Never throws: a
 * throw would fail the tool call and invite the model to file it again.
 */
const autoApprove: NonNullable<ToolDeps['autoApprove']> = async (id) => {
  let claimed
  try {
    claimed = await claimDecision(id, true, 'agent')
  } catch (err) {
    // Nothing claimed, nothing ran: the row still awaits the owner, so the tool
    // reports an ordinary awaiting_approval (lib/agent/tools.ts).
    console.error('[api/agent/run] auto-approve claim failed:', errText(err))
    return {
      status: 'failed',
      result: { still_awaiting: true },
      error: `${errText(err)} — not approved and nothing ran; it still awaits the owner at /actions/${id}`,
    }
  }
  if (!claimed) return handledElsewhere(id)
  try {
    // Best effort: strip the Telegram prompt's buttons so nobody taps a handled action.
    try {
      const autoText = `⚡ Auto-approved (skip mode) — ${claimed.kind}`
      const messageId = claimed.telegram_message_id
      const route = routeItemForAction(claimed)
      await alert({
        source: 'lume.agent', severity: 'info', title: titleFrom(autoText), body: autoText,
        link: alertLink(`/actions/${id}`), campaign_id: route.campaign_id, scope: route.scope,
        telegram: messageId ? () => editMessage(messageId, autoText) : undefined,
      })
    } catch (err) {
      console.error('[api/agent/run] telegram edit failed:', errText(err))
    }
    // Skip mode shows the outcome to whoever runs this chat: a minted sign-in
    // link rides back in the tool result once (agent_messages / agent_runs
    // store only a masked copy; lib/operators/mask.ts).
    const o = await executeAction(id, { revealOnce: true })
    if (!o.ran) return handledElsewhere(id, o.status)
    const result = o.reveal
      ? { ...o.result, sign_in_url: o.reveal.sign_in_url, sign_in_url_note: 'Shown once. Lume keeps only a masked copy; give this link to the new Grok Bot now.' }
      : o.result
    return { status: o.status, result, error: o.error }
  } catch (err) {
    // Claimed, and the executor may have reached Instantly before it threw.
    console.error('[api/agent/run] auto-approved execution failed:', errText(err))
    return {
      status: 'failed',
      result: { uncertain: true },
      error: `${errText(err)} — may have partly run; check /actions/${id} before retrying`,
    }
  }
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
  skipPermissions,
  send: emit,
}: {
  runId: string
  prompt: string
  /** The owner's own words (the prompt may carry packed history). */
  title: string
  origin: string
  conversationId: string
  skipPermissions: boolean
  send: (e: SseEvent) => void
}): Promise<RunReply> {
  // Mirror what the browser shows, so a reloaded conversation looks the same.
  const reply: RunReply = { text: '', tools: [], approvals: [], error: null }
  const send = (e: SseEvent) => {
    if (e.type === 'text') reply.text += String(e.delta ?? '')
    else if (e.type === 'approval') {
      const a: StoredApproval = {
        action_id: String(e.action_id),
        deep_link: String(e.deep_link ?? `/actions/${e.action_id}`),
        summary: (e.summary as string | null) ?? null,
        tool: String(e.tool ?? ''),
        ...(e.state ? { state: e.state as StoredApproval['state'] } : {}),
      }
      reply.approvals = [...reply.approvals.filter((x) => x.action_id !== a.action_id), a]
    } else if (e.type === 'error') reply.error = String(e.message ?? 'The run failed.')
    emit(e)
  }
  const toolCalls: ToolCallEntry[] = []
  let approvalActionId: string | null = null
  // Tool calls skip mode settled (ran, failed, or found handled): stored as ok / error, not awaiting.
  const autoRan = new Map<string, 'ok' | 'error'>()
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
      if (ok && result?.status === 'auto_approved' && typeof result.action_id === 'string' && result.action_id) {
        // Skip mode already ran it: show the card, but the run does not wait.
        if (entry) entry.action_id = result.action_id
        const state: StoredApproval['state'] =
          result.outcome === 'executed' ? 'auto_executed' : result.outcome === 'handled_elsewhere' ? 'handled_elsewhere' : 'auto_failed'
        autoRan.set(id, state === 'auto_failed' ? 'error' : 'ok')
        send({ type: 'approval', action_id: result.action_id, deep_link: result.deep_link, summary: result.summary ?? null, tool: name, tool_id: id, state })
        await save({ tool_calls: snapshot() })
        return
      }
      if (ok && result?.status === 'awaiting_approval' && typeof result?.action_id === 'string' && result.action_id) {
        approvalActionId = result.action_id
        if (entry) entry.action_id = result.action_id
        send({ type: 'approval', action_id: result.action_id, deep_link: result.deep_link, summary: result.summary ?? null, tool: name, tool_id: id, state: 'awaiting' })
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
      skipPermissions,
      autoApprove,
      skills: { list: () => listSkills(), get: getSkill, findByName: findSkillByName, create: createSkill },
      notify: async (raw) => {
        // Telegram and the feed both get the masked text: a sign-in link is never sent or stored in plaintext.
        const text = maskKeyText(raw, { bare: true })
        const r = await alert({
          source: 'lume.agent', severity: 'info', title: titleFrom(text), body: text,
          link: alertLink(`/agent?c=${conversationId}`),
          telegram: () => sendMessage(text, { disablePreview: true }),
        })
        // Telegram switched off: the feed row is the delivery.
        if (!r) return { ok: true }
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
      // Server-side web tools run on Anthropic's side; surface them live as a status line.
      messageStream.on('streamEvent', (ev) => {
        if (ev.type !== 'content_block_start' || ev.content_block.type !== 'server_tool_use') return
        const name = ev.content_block.name
        send({ type: 'status', label: name === 'web_search' ? 'Searching the web' : name === 'web_fetch' ? 'Reading a web page' : 'Working' })
      })
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
    status: autoRan.get(c.id) ?? (c.status === 'ok' && c.tier === 'high' ? 'awaiting' : c.status),
    ...(c.ms !== undefined ? { ms: c.ms } : {}),
    ...(c.error ? { error: c.error } : {}),
  }))
  if (status === 'failed' && !reply.error && !reply.text) reply.error = outcome || 'The run failed.'
  return reply
}
