import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * /api/agent/run with the Anthropic SDK, the DB writes, createAction and
 * Telegram all mocked: no network, no live writes, no Claude calls.
 */

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  insertAgentRun: vi.fn(),
  updateAgentRun: vi.fn(),
  failStaleRuns: vi.fn(),
  createAction: vi.fn(),
  logEvent: vi.fn(),
  sendMessage: vi.fn(),
  fetch: vi.fn(),
  toolRunner: vi.fn(),
  loadKnowledge: vi.fn(),
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  getMessages: vi.fn(),
  insertMessage: vi.fn(),
  getSkill: vi.fn(),
  markSkillRun: vi.fn(),
  claimDecision: vi.fn(),
  executeAction: vi.fn(),
  editMessage: vi.fn(),
  getAction: vi.fn(),
  currentOperator: vi.fn(),
  getVertical: vi.fn(),
  getProject: vi.fn(),
  projectForVertical: vi.fn(),
  itemsForBlock: vi.fn(),
}))
vi.mock('@/lib/agent/projects', () => ({ getProject: h.getProject, projectForVertical: h.projectForVertical, itemsForBlock: h.itemsForBlock }))
vi.mock('@/lib/operators/session', () => ({ currentOperator: h.currentOperator }))
vi.mock('@/lib/operators/store', () => ({ getVertical: h.getVertical }))

vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/agent/runs', () => ({ insertAgentRun: h.insertAgentRun, updateAgentRun: h.updateAgentRun, failStaleRuns: h.failStaleRuns }))
vi.mock('@/lib/agent/conversations', () => ({
  createConversation: h.createConversation,
  getConversation: h.getConversation,
  getMessages: h.getMessages,
  insertMessage: h.insertMessage,
}))
vi.mock('@/lib/agent/skills', () => ({
  getSkill: h.getSkill,
  markSkillRun: h.markSkillRun,
  listSkills: vi.fn(),
  findSkillByName: vi.fn(),
  createSkill: vi.fn(),
}))
vi.mock('@/lib/actions/create', () => ({ createAction: h.createAction }))
vi.mock('@/lib/agent/memory', () => ({ loadKnowledge: h.loadKnowledge }))
vi.mock('@/lib/db/service', () => ({ logEvent: h.logEvent, isDbError: () => false }))
vi.mock('@/lib/adapters/telegram', () => ({ sendMessage: h.sendMessage, editMessage: h.editMessage }))
vi.mock('@/lib/actions/store', () => ({ claimDecision: h.claimDecision, getAction: h.getAction }))
vi.mock('@/lib/actions/execute', () => ({ executeAction: h.executeAction }))
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number
  }
  class Anthropic {
    static APIError = APIError
    beta = { messages: { toolRunner: h.toolRunner } }
  }
  return { default: Anthropic, APIError }
})

vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
import { feed } from '../stubs/feed'

import { POST } from '@/app/api/agent/run/route'

type FakeTool = { name: string; run: (input: unknown, ctx: unknown) => Promise<unknown> }

/** One streamed turn: optionally runs tools (as the runner would), then yields a fake message stream. */
function fakeRunner(turns: { text: string; call?: { name: string; input: unknown } }[], results: unknown[] = []) {
  h.toolRunner.mockImplementation((params: { tools: FakeTool[] }) => ({
    async *[Symbol.asyncIterator]() {
      for (const turn of turns) {
        const listeners: ((d: string) => void)[] = []
        yield {
          on: (_e: string, cb: (d: string) => void) => listeners.push(cb),
          finalMessage: async () => {
            listeners.forEach((cb) => cb(turn.text))
            return {
              content: [{ type: 'text', text: turn.text }],
              stop_reason: turn.call ? 'tool_use' : 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
            }
          },
        }
        if (turn.call) {
          const tool = params.tools.find((t) => t.name === turn.call!.name)!
          // What the model sees: the tool result as JSON text.
          results.push(JSON.parse(String(await tool.run(turn.call.input, { toolUse: { id: `tu-${turn.call.name}` } }))))
        }
      }
    },
  }))
}

function post(prompt: string, extra: Record<string, unknown> = {}) {
  return POST(new Request('https://lume.test/api/agent/run', { method: 'POST', body: JSON.stringify({ prompt, ...extra }) }))
}

const CONV = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'

async function events(res: Response) {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
}

beforeEach(() => {
  vi.stubGlobal('fetch', h.fetch)
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session', user: {} })
  h.insertAgentRun.mockResolvedValue({ id: 'run-1' })
  h.updateAgentRun.mockResolvedValue(undefined)
  h.failStaleRuns.mockResolvedValue(0)
  h.createAction.mockResolvedValue({ id: 'act-1' })
  h.logEvent.mockResolvedValue(null)
  h.createConversation.mockResolvedValue({ id: 'conv-new', title: 't', created_at: '', updated_at: '' })
  h.getConversation.mockResolvedValue({ id: CONV, title: 'Old', created_at: '', updated_at: '' })
  h.getMessages.mockResolvedValue([])
  h.insertMessage.mockResolvedValue(undefined)
  h.loadKnowledge.mockResolvedValue('')
  h.currentOperator.mockResolvedValue(null)
  h.getProject.mockResolvedValue(null)
  h.projectForVertical.mockResolvedValue(null)
  h.itemsForBlock.mockResolvedValue([])
  process.env.ANTHROPIC_API_KEY = 'test-key'
  feed.rows = []
  delete process.env.ALERT_CHANNELS
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  delete process.env.ANTHROPIC_API_KEY
})

describe('POST /api/agent/run', () => {
  it('is owner-gated', async () => {
    const { NextResponse } = await import('next/server')
    h.requireOwner.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) })
    expect((await post('hi')).status).toBe(401)
    expect(h.insertAgentRun).not.toHaveBeenCalled()
  })

  it('503 agent_not_configured when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await post('hi')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'agent_not_configured' })
    expect(h.insertAgentRun).not.toHaveBeenCalled()
    expect(h.toolRunner).not.toHaveBeenCalled()
  })

  it('puts saved memories in the user turn, not the system prompt', async () => {
    h.loadKnowledge.mockResolvedValueOnce('What Lume knows (saved):\n- [client] Kaspen sells PM growth')
    fakeRunner([{ text: 'ok' }])
    await (await post('plan Kaspen')).text()
    const params = h.toolRunner.mock.calls.at(-1)![0]
    expect(params.messages[0].content).toMatch(/^What Lume knows[\s\S]*Kaspen sells PM growth[\s\S]*plan Kaspen$/)
    expect(String(params.system)).not.toContain('Kaspen sells')
    expect(h.insertAgentRun.mock.calls.at(-1)![0]).not.toContain('What Lume knows')
  })

  it('streams text and finishes done with usage', async () => {
    fakeRunner([{ text: 'All quiet.' }])
    const res = await post('status?')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    // A stream may carry a sign-in link once: never cached anywhere.
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform')
    const ev = await events(res)
    expect(ev[0]).toEqual({ type: 'run', id: 'run-1', conversation_id: 'conv-new' })
    expect(ev).toContainEqual({ type: 'text', delta: 'All quiet.' })
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'done' })
    expect(h.toolRunner.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5-5', stream: true, thinking: { type: 'adaptive' } })
    expect(h.insertAgentRun).toHaveBeenCalledWith('status?', 'claude-sonnet-5-5')
    const last = h.updateAgentRun.mock.calls.at(-1)!
    expect(last[0]).toBe('run-1')
    expect(last[1]).toMatchObject({ status: 'done', outcome: 'All quiet.', usage: { input_tokens: 10, output_tokens: 5 } })
  })

  it('a high-risk tool creates a pending action and sets needs_approval, never fetching', async () => {
    fakeRunner([
      { text: 'Plan: pause it.', call: { name: 'pause_campaign', input: { campaign_id: 'c1' } } },
      { text: 'Waiting for your approval.' },
    ])
    const ev = await events(await post('pause c1'))
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.createAction).toHaveBeenCalledWith('pause_campaign', expect.objectContaining({ campaign_id: 'c1' }), 'agent', { agentRunId: 'run-1' })
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', action_id: 'act-1', deep_link: '/actions/act-1' }))
    expect(h.updateAgentRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'needs_approval', approval_action_id: 'act-1' }))
    const last = h.updateAgentRun.mock.calls.at(-1)![1]
    expect(last).toMatchObject({ status: 'needs_approval', approval_action_id: 'act-1' })
    expect(last.tool_calls).toEqual([expect.objectContaining({ name: 'pause_campaign', tier: 'high', status: 'ok', action_id: 'act-1' })])
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'needs_approval' })
  })

  it('a read tool calls Lume with the internal bearer and logs the call', async () => {
    process.env.LUME_INTERNAL_SECRET = 'internal'
    h.fetch.mockResolvedValue(new Response('[]'))
    fakeRunner([{ text: '', call: { name: 'list_rules', input: {} } }, { text: 'No rules.' }])
    const ev = await events(await post('rules?'))
    expect(h.fetch.mock.calls[0][0]).toBe('https://lume.test/api/rules')
    expect(h.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer internal')
    expect(ev).toContainEqual(expect.objectContaining({ type: 'tool_start', name: 'list_rules', tier: 'read' }))
    expect(ev).toContainEqual(expect.objectContaining({ type: 'tool_end', name: 'list_rules', ok: true }))
    expect(h.updateAgentRun.mock.calls.at(-1)![1]).toMatchObject({ status: 'done' })
    delete process.env.LUME_INTERNAL_SECRET
  })

  it('tool fetches go to the request origin, never LUME_URL (a local run must not call prod)', async () => {
    vi.stubEnv('LUME_URL', 'https://lume-prod.example.com')
    vi.stubEnv('LUME_INTERNAL_URL', '')
    h.fetch.mockResolvedValue(new Response('[]'))
    fakeRunner([{ text: '', call: { name: 'list_rules', input: {} } }, { text: 'No rules.' }])
    await events(
      await POST(new Request('http://localhost:3000/api/agent/run', { method: 'POST', body: JSON.stringify({ prompt: 'rules?' }) }))
    )
    expect(h.fetch.mock.calls[0][0]).toBe('http://localhost:3000/api/rules')
    vi.unstubAllEnvs()
  })

  it('LUME_INTERNAL_URL wins for tool fetches when set', async () => {
    vi.stubEnv('LUME_INTERNAL_URL', 'http://10.0.0.5:3000/')
    h.fetch.mockResolvedValue(new Response('[]'))
    fakeRunner([{ text: '', call: { name: 'list_rules', input: {} } }, { text: 'No rules.' }])
    await events(await post('rules?'))
    expect(h.fetch.mock.calls[0][0]).toBe('http://10.0.0.5:3000/api/rules')
    vi.unstubAllEnvs()
  })

  it('closes runs left running for over 6 minutes before starting a new one', async () => {
    const t0 = Date.now()
    fakeRunner([{ text: 'ok' }])
    await events(await post('hi'))
    expect(h.failStaleRuns).toHaveBeenCalledOnce()
    const cutoff = (h.failStaleRuns.mock.calls[0][0] as Date).getTime()
    expect(cutoff).toBeGreaterThanOrEqual(t0 - 6 * 60_000 - 50)
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 6 * 60_000 + 50)
    expect(h.failStaleRuns.mock.invocationCallOrder[0]).toBeLessThan(h.insertAgentRun.mock.invocationCallOrder[0])
  })

  it('a failing stale-run cleanup does not block the run', async () => {
    h.failStaleRuns.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeRunner([{ text: 'ok' }])
    const ev = await events(await post('hi'))
    expect(ev.at(-1)).toMatchObject({ type: 'done' })
  })

  it('a runner error marks the run failed', async () => {
    h.toolRunner.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('boom')
      },
    }))
    const ev = await events(await post('x'))
    expect(ev).toContainEqual({ type: 'error', message: 'boom' })
    expect(h.updateAgentRun.mock.calls.at(-1)![1]).toMatchObject({ status: 'failed', outcome: 'boom' })
  })

  describe('chat history', () => {
    it('no conversation_id: creates one titled from the prompt and stores both turns', async () => {
      fakeRunner([{ text: 'All quiet.' }])
      const ev = await events(await post('What is waiting on me today?'))
      expect(h.createConversation).toHaveBeenCalledWith('What is waiting on me today?')
      expect(h.getConversation).not.toHaveBeenCalled()
      expect(ev[0]).toMatchObject({ type: 'run', conversation_id: 'conv-new' })
      expect(h.insertMessage).toHaveBeenNthCalledWith(1, { conversation_id: 'conv-new', role: 'user', text: 'What is waiting on me today?', run_id: 'run-1' })
      expect(h.insertMessage).toHaveBeenNthCalledWith(2, {
        conversation_id: 'conv-new',
        role: 'assistant',
        run_id: 'run-1',
        text: 'All quiet.',
        tools: [],
        approvals: [],
        error: null,
      })
      // The user turn is stored before the model runs.
      expect(h.insertMessage.mock.invocationCallOrder[0]).toBeLessThan(h.toolRunner.mock.invocationCallOrder[0])
    })

    it('a Grok Bot operator: the new conversation stores its vertical + operator; the prompt names the bot', async () => {
      h.currentOperator.mockResolvedValue({ id: 'op-1', vertical_id: 'v-roof', is_master: false, label: 'Roofers bot', revoked_at: null })
      h.getVertical.mockResolvedValue({ id: 'v-roof', name: 'Roofers', campaign_ids: ['camp-r1'] })
      fakeRunner([{ text: 'On it.' }])
      await events(await post('What needs me?'))
      expect(h.createConversation).toHaveBeenCalledWith('What needs me?', { vertical_id: 'v-roof', operator_id: 'op-1' })
      const sent = h.toolRunner.mock.calls[0][0].messages[0].content as string
      expect(sent).toMatch(/^You are being operated by the Roofers Grok Bot \(operator\)\. Its campaigns: camp-r1\. It has the owner’s full authority\.\n\nWhat needs me\?$/)
      // The stored user turn stays the bot's own words.
      expect(h.insertMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: 'What needs me?' }))
    })

    it('the master bot: no vertical on the conversation; the prompt says it oversees all verticals', async () => {
      h.currentOperator.mockResolvedValue({ id: 'op-m', vertical_id: null, is_master: true, label: 'Master', revoked_at: null })
      fakeRunner([{ text: 'ok' }])
      await events(await post('Stand up a dentists vertical'))
      expect(h.createConversation).toHaveBeenCalledWith('Stand up a dentists vertical', { vertical_id: null, operator_id: 'op-m' })
      expect(h.getVertical).not.toHaveBeenCalled()
      expect(h.toolRunner.mock.calls[0][0].messages[0].content).toMatch(/^You are being operated by the master Grok Bot.*oversees all verticals/)
    })

    it('an existing conversation keeps its tags; the operator line still leads the prompt', async () => {
      h.currentOperator.mockResolvedValue({ id: 'op-1', vertical_id: 'v-roof', is_master: false, label: 'Roofers bot', revoked_at: null })
      h.getVertical.mockResolvedValue({ id: 'v-roof', name: 'Roofers', campaign_ids: [] })
      fakeRunner([{ text: 'ok' }])
      await events(await post('next', { conversation_id: CONV }))
      expect(h.createConversation).not.toHaveBeenCalled()
      expect(h.toolRunner.mock.calls[0][0].messages[0].content).toMatch(/^You are being operated by the Roofers Grok Bot[^\n]*Its campaigns: none\./)
    })

    it('the owner opening a vertical (from /operator): the new chat is tagged with it and the prompt names it', async () => {
      const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
      h.getVertical.mockResolvedValue({ id: VID, name: 'Roofers', campaign_ids: ['camp-r1'] })
      fakeRunner([{ text: 'ok' }])
      await events(await post('How are we doing?', { vertical_id: VID }))
      expect(h.getVertical).toHaveBeenCalledWith(VID)
      expect(h.createConversation).toHaveBeenCalledWith('How are we doing?', { vertical_id: VID, operator_id: null })
      expect(h.toolRunner.mock.calls[0][0].messages[0].content).toMatch(/^This conversation is about the Roofers vertical\. Its campaigns: camp-r1\.\n\nHow are we doing\?$/)
    })

    it('an operator ignores a requested vertical_id (its own vertical wins)', async () => {
      h.currentOperator.mockResolvedValue({ id: 'op-1', vertical_id: 'v-roof', is_master: false, label: 'Roofers bot', revoked_at: null })
      h.getVertical.mockResolvedValue({ id: 'v-roof', name: 'Roofers', campaign_ids: [] })
      fakeRunner([{ text: 'ok' }])
      await events(await post('hi', { vertical_id: '3941b73f-c74e-4cc5-9766-f0140e6ad9c9' }))
      expect(h.createConversation).toHaveBeenCalledWith('hi', { vertical_id: 'v-roof', operator_id: 'op-1' })
    })

    it('the internal bearer is never treated as an operator', async () => {
      h.requireOwner.mockResolvedValue({ ok: true, via: 'internal', user: null })
      fakeRunner([{ text: 'ok' }])
      await events(await post('hi'))
      expect(h.currentOperator).not.toHaveBeenCalled()
      expect(h.createConversation).toHaveBeenCalledWith('hi')
    })

    it('with conversation_id: packs the stored turns ahead of the new message (never client-supplied)', async () => {
      h.getMessages.mockResolvedValue([
        { role: 'user', text: 'pause campaign A' },
        { role: 'assistant', text: 'Filed it for approval.' },
      ])
      fakeRunner([{ text: 'Done.' }])
      const ev = await events(await post('and B?', { conversation_id: CONV.toUpperCase() }))
      expect(h.getConversation).toHaveBeenCalledWith(CONV)
      expect(h.createConversation).not.toHaveBeenCalled()
      const sent = h.toolRunner.mock.calls[0][0].messages[0].content as string
      expect(sent).toContain('Owner: pause campaign A')
      expect(sent).toContain('Lume: Filed it for approval.')
      expect(sent.endsWith('Current request:\nand B?')).toBe(true)
      expect(h.insertAgentRun).toHaveBeenCalledWith(sent, 'claude-sonnet-5-5')
      expect(h.insertMessage.mock.calls[0][0]).toMatchObject({ conversation_id: CONV, role: 'user', text: 'and B?' })
      expect(ev[0]).toMatchObject({ conversation_id: CONV })
      expect(h.logEvent.mock.calls[0][0]).toMatchObject({ title: 'and B?' })
    })

    it('404 for a missing or deleted conversation, before any run is recorded', async () => {
      h.getConversation.mockResolvedValue(null)
      const res = await post('hi', { conversation_id: CONV })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'conversation_not_found' })
      expect(h.insertAgentRun).not.toHaveBeenCalled()
      expect(h.insertMessage).not.toHaveBeenCalled()
    })

    it('400 for a malformed conversation_id', async () => {
      expect((await post('hi', { conversation_id: 'nope' })).status).toBe(400)
    })

    it('stores the tool log (high tier as awaiting) and approval cards with the reply', async () => {
      fakeRunner([
        { text: 'Plan: pause it.', call: { name: 'pause_campaign', input: { campaign_id: 'c1' } } },
        { text: 'Waiting for your approval.' },
      ])
      await events(await post('pause c1'))
      const reply = h.insertMessage.mock.calls.at(-1)![0]
      expect(reply.text).toBe('Plan: pause it.\n\nWaiting for your approval.')
      expect(reply.tools).toEqual([expect.objectContaining({ name: 'pause_campaign', tier: 'high', status: 'awaiting' })])
      expect(reply.tools[0]).not.toHaveProperty('input')
      expect(reply.approvals).toEqual([{ action_id: 'act-1', deep_link: '/actions/act-1', summary: expect.anything(), tool: 'pause_campaign', state: 'awaiting' }])
    })

    it('stores the error when the run fails', async () => {
      h.toolRunner.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          throw new Error('boom')
        },
      }))
      await events(await post('x'))
      expect(h.insertMessage.mock.calls.at(-1)![0]).toMatchObject({ role: 'assistant', text: '', error: 'boom' })
    })

    it('a failed reply write is logged and the stream still ends cleanly', async () => {
      h.insertMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('db down'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      fakeRunner([{ text: 'ok' }])
      const ev = await events(await post('hi'))
      expect(ev.at(-1)).toMatchObject({ type: 'done' })
    })

    it('a failed conversation create is a 500 and nothing runs', async () => {
      h.createConversation.mockRejectedValue(new Error('db down'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await post('hi')
      expect(res.status).toBe(500)
      expect(h.toolRunner).not.toHaveBeenCalled()
    })
  })
})

describe('POST /api/agent/run in skip-permissions mode', () => {
  const pause = [
    { text: 'Pausing it.', call: { name: 'pause_campaign', input: { campaign_id: 'c1' } } },
    { text: 'Paused.' },
  ]

  beforeEach(() => {
    h.claimDecision.mockResolvedValue({ id: 'act-1', kind: 'pause_campaign', telegram_message_id: 42 })
    h.executeAction.mockResolvedValue({ ran: true, status: 'executed', result: { paused: true }, error: null })
    h.editMessage.mockResolvedValue({ ok: true })
  })

  it('a skippable kind is claimed as the agent, executed, and the run ends done', async () => {
    fakeRunner(pause)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(h.createAction).toHaveBeenCalledWith('pause_campaign', expect.anything(), 'agent', { agentRunId: 'run-1' })
    expect(h.claimDecision).toHaveBeenCalledWith('act-1', true, 'agent')
    expect(h.executeAction).toHaveBeenCalledWith('act-1', { revealOnce: true, origin: expect.any(String) })
    expect(h.editMessage).toHaveBeenCalledWith(42, expect.stringContaining('Auto-approved'))
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', action_id: 'act-1', tool: 'pause_campaign', state: 'auto_executed' }))
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'done' })
    expect(h.updateAgentRun).not.toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'needs_approval' }))
    const last = h.updateAgentRun.mock.calls.at(-1)![1]
    expect(last).not.toHaveProperty('approval_action_id')
    expect(last.tool_calls).toEqual([expect.objectContaining({ name: 'pause_campaign', status: 'ok', action_id: 'act-1' })])
    const reply = h.insertMessage.mock.calls.at(-1)![0]
    expect(reply.tools).toEqual([expect.objectContaining({ name: 'pause_campaign', status: 'ok' })])
    expect(reply.approvals).toEqual([expect.objectContaining({ action_id: 'act-1', state: 'auto_executed' })])
  })

  it('a vertical Grok Bot run never auto-approves an operator-key request (defence in depth)', async () => {
    h.currentOperator.mockResolvedValue({ id: 'op-1', vertical_id: 'v-roof', is_master: false, label: 'Roof bot', revoked_at: null })
    h.getVertical.mockResolvedValue({ id: 'v-roof', name: 'Roofers', campaign_ids: [] })
    h.getAction.mockResolvedValue({ id: 'act-1', kind: 'issue_operator_key', status: 'awaiting' })
    fakeRunner(pause)
    await events(await post('pause c1', { skip_permissions: true }))
    expect(h.claimDecision).not.toHaveBeenCalled()
    expect(h.executeAction).not.toHaveBeenCalled()
  })

  it('skip mode passes the public origin so a revealed link is absolute', async () => {
    fakeRunner(pause)
    await events(await post('pause c1', { skip_permissions: true }))
    expect(h.executeAction).toHaveBeenCalledWith('act-1', { revealOnce: true, origin: expect.stringMatching(/^https?:\/\//) })
  })

  it('a failed execution is auto_failed and its tool entry an error', async () => {
    h.executeAction.mockResolvedValue({ ran: true, status: 'failed', result: {}, error: 'instantly 500' })
    fakeRunner(pause)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', state: 'auto_failed' }))
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'done' })
    expect(h.insertMessage.mock.calls.at(-1)![0].tools).toEqual([expect.objectContaining({ status: 'error' })])
  })

  it('a lost claim is handled_elsewhere (with the row status), stored ok, and runs nothing', async () => {
    h.claimDecision.mockResolvedValue(null)
    h.getAction.mockResolvedValue({ id: 'act-1', status: 'rejected' })
    const results: unknown[] = []
    fakeRunner(pause, results)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(h.executeAction).not.toHaveBeenCalled()
    expect(h.getAction).toHaveBeenCalledWith('act-1')
    expect(results[0]).toMatchObject({ status: 'auto_approved', outcome: 'handled_elsewhere', result: { status: 'rejected' } })
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', state: 'handled_elsewhere' }))
    expect(h.insertMessage.mock.calls.at(-1)![0].tools).toEqual([expect.objectContaining({ status: 'ok' })])
    expect(h.insertMessage.mock.calls.at(-1)![0].approvals).toEqual([expect.objectContaining({ state: 'handled_elsewhere' })])
  })

  it('executeAction ran:false after the claim is handled_elsewhere too', async () => {
    h.executeAction.mockResolvedValue({ ran: false, reason: 'not_claimable', status: 'executing' })
    const results: unknown[] = []
    fakeRunner(pause, results)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(results[0]).toMatchObject({ outcome: 'handled_elsewhere', result: { status: 'executing' } })
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', state: 'handled_elsewhere' }))
  })

  it('a claim DB error leaves the action awaiting: nothing runs and the run ends needs_approval', async () => {
    h.claimDecision.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const results: unknown[] = []
    fakeRunner(pause, results)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(h.executeAction).not.toHaveBeenCalled()
    expect(results[0]).toEqual({
      status: 'awaiting_approval',
      action_id: 'act-1',
      deep_link: '/actions/act-1',
      summary: expect.any(String),
      note: 'Skip mode could not auto-approve; it awaits the owner.',
    })
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', action_id: 'act-1', state: 'awaiting' }))
    expect(ev).not.toContainEqual(expect.objectContaining({ type: 'approval', state: 'auto_failed' }))
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'needs_approval', approval_action_id: 'act-1' })
    const msg = h.insertMessage.mock.calls.at(-1)![0]
    expect(msg.tools).toEqual([expect.objectContaining({ status: 'awaiting' })])
    expect(msg.approvals).toEqual([expect.objectContaining({ action_id: 'act-1', state: 'awaiting' })])
  })

  it('executeAction throwing after the claim is auto_failed and flagged uncertain; the run carries on', async () => {
    h.executeAction.mockRejectedValue(new Error('socket hang up'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const results: unknown[] = []
    fakeRunner(pause, results)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(results[0]).toMatchObject({
      status: 'auto_approved',
      outcome: 'failed',
      result: { uncertain: true },
      error: 'socket hang up — may have partly run; check /actions/act-1 before retrying',
    })
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', action_id: 'act-1', state: 'auto_failed' }))
    expect(ev).toContainEqual({ type: 'text', delta: 'Paused.' })
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'done' })
    expect(h.createAction).toHaveBeenCalledTimes(1)
  })

  it('a failing Telegram edit does not stop the execution', async () => {
    h.editMessage.mockRejectedValue(new Error('tg down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeRunner(pause)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(h.executeAction).toHaveBeenCalledWith('act-1', { revealOnce: true, origin: expect.any(String) })
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', state: 'auto_executed' }))
  })

  it('without skip_permissions nothing is auto-approved', async () => {
    fakeRunner(pause)
    const ev = await events(await post('pause c1'))
    expect(h.claimDecision).not.toHaveBeenCalled()
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', state: 'awaiting' }))
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'needs_approval' })
  })

  it('an always-ask kind still waits in skip mode', async () => {
    fakeRunner([
      { text: '', call: { name: 'send_reply', input: { eaccount: 'me@send.com', campaign_id: 'c', reply_to_uuid: 'e', body: 'hi' } } },
      { text: 'Waiting.' },
    ])
    const ev = await events(await post('reply', { skip_permissions: true }))
    expect(h.claimDecision).not.toHaveBeenCalled()
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'needs_approval' })
  })

  it('stores auto: true on an automatic follow-up turn', async () => {
    fakeRunner([{ text: 'Noted.' }])
    await events(await post('Approved: pause c1', { auto: true }))
    expect(h.insertMessage.mock.calls[0][0]).toMatchObject({ role: 'user', text: 'Approved: pause c1', auto: true })
  })

  it('400 for a non-boolean skip_permissions', async () => {
    expect((await post('hi', { skip_permissions: 'yes' })).status).toBe(400)
  })
})

describe('POST /api/agent/run with a saved skill', () => {
  const SKILL = '11111111-2222-4333-8444-555555555555'
  const skill = { id: SKILL, name: 'Roofers', description: '', steps: [{ type: 'launch' }], variables: [], source_conversation_id: null, created_at: '', updated_at: '', last_run_at: null, run_count: 0 }
  const promptSent = () => (h.toolRunner.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content

  it('run: injects the RUN block ahead of the message and bumps the run count', async () => {
    h.getSkill.mockResolvedValue(skill)
    fakeRunner([{ text: 'Which city?' }])
    await events(await post('Run the skill "Roofers".', { skill_id: SKILL.toUpperCase(), skill_mode: 'run' }))
    expect(h.getSkill).toHaveBeenCalledWith(SKILL)
    expect(promptSent()).toMatch(/^The owner chose to RUN the saved skill "Roofers"/)
    expect(promptSent()).toContain('Run the skill "Roofers".')
    expect(h.markSkillRun).toHaveBeenCalledWith(SKILL)
    // The stored user message is the owner's own words, not the skill block.
    expect(h.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', text: 'Run the skill "Roofers".' }))
  })

  it('reference: context only, no run count', async () => {
    h.getSkill.mockResolvedValue(skill)
    fakeRunner([{ text: 'ok' }])
    await events(await post('Make one like this for dentists', { skill_id: SKILL, skill_mode: 'reference' }))
    expect(promptSent()).toContain('as reference only')
    expect(promptSent()).not.toContain('RUN the saved skill')
    expect(h.markSkillRun).not.toHaveBeenCalled()
  })

  it('404 skill_not_found when the skill is missing; no run starts', async () => {
    h.getSkill.mockResolvedValue(null)
    const res = await post('go', { skill_id: SKILL, skill_mode: 'run' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'skill_not_found' })
    expect(h.insertAgentRun).not.toHaveBeenCalled()
    expect(h.createConversation).not.toHaveBeenCalled()
    expect(h.toolRunner).not.toHaveBeenCalled()
  })
})

describe('agent run alerts (G4)', () => {
  const notifyTurns = [
    { text: 'Telling you.', call: { name: 'notify', input: { text: 'batch is done' } } },
    { text: 'Sent.' },
  ]

  it('notify: the exact Telegram message as before, plus an info feed row linked to the conversation', async () => {
    h.sendMessage.mockResolvedValue({ ok: true, messageId: 1 })
    const results: unknown[] = []
    fakeRunner(notifyTurns, results)
    await events(await post('tell me', { conversation_id: CONV }))
    expect(h.sendMessage).toHaveBeenCalledWith('Lume agent: batch is done', { disablePreview: true })
    expect(results[0]).toEqual({ status: 'sent' })
    expect(feed.rows).toEqual([expect.objectContaining({
      source: 'lume.agent', severity: 'info', title: 'Lume agent: batch is done', link: `/agent?c=${CONV}`,
    })])
  })

  it('notify never carries an operator sign-in link in plaintext (Telegram text and feed row)', async () => {
    h.sendMessage.mockResolvedValue({ ok: true, messageId: 1 })
    fakeRunner([{ text: 'x', call: { name: 'notify', input: { text: 'new bot: https://l.test/auth/operator?k=SECRETKEY9876543210abcdefghijklmnopqrstuvwx' } } }, { text: 'ok' }], [])
    await events(await post('tell me', { conversation_id: CONV }))
    expect(JSON.stringify(h.sendMessage.mock.calls)).not.toContain('SECRETKEY9876543210abcdefghijklmnopqrstuvwx')
    expect(JSON.stringify(h.sendMessage.mock.calls)).toContain('k=SECR****')
    expect(JSON.stringify(feed.rows)).not.toContain('SECRETKEY9876543210abcdefghijklmnopqrstuvwx')
  })

  it('notify with ALERT_CHANNELS=feed: no Telegram send, the tool still reports sent', async () => {
    process.env.ALERT_CHANNELS = 'feed'
    const results: unknown[] = []
    fakeRunner(notifyTurns, results)
    await events(await post('tell me', { conversation_id: CONV }))
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(results[0]).toEqual({ status: 'sent' })
    expect(feed.rows).toHaveLength(1)
  })

  it('skip-mode auto-approve: the same Telegram edit, plus an info row; off → no edit, still a row', async () => {
    h.claimDecision.mockResolvedValue({ id: 'act-1', kind: 'pause_campaign', payload: { campaign_id: 'c1' }, telegram_message_id: 42 })
    h.executeAction.mockResolvedValue({ ran: true, status: 'executed', result: {}, error: null })
    h.editMessage.mockResolvedValue({ ok: true })
    const pause = [{ text: 'Pausing.', call: { name: 'pause_campaign', input: { campaign_id: 'c1' } } }, { text: 'Done.' }]
    fakeRunner(pause)
    await events(await post('pause c1', { skip_permissions: true }))
    expect(h.editMessage).toHaveBeenCalledWith(42, '⚡ Auto-approved (skip mode) — pause_campaign')
    expect(feed.rows).toEqual([expect.objectContaining({
      source: 'lume.agent', title: '⚡ Auto-approved (skip mode) — pause_campaign', link: '/actions/act-1', campaign_id: 'c1', scope: 'campaign',
    })])

    h.editMessage.mockClear()
    feed.rows = []
    process.env.ALERT_CHANNELS = 'feed'
    fakeRunner(pause)
    await events(await post('pause c1', { skip_permissions: true }))
    expect(h.editMessage).not.toHaveBeenCalled()
    expect(feed.rows).toHaveLength(1)
  })
})

describe('projects', () => {
  const PID = '7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
  const FID = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e'
  const roofers = { id: PID, name: 'Roofers Austin', instructions: 'Never order more than 2k.', vertical_id: VID, position: 0, created_at: '', updated_at: '' }
  const note = { id: FID, kind: 'note', name: 'Tone', mime: 'text/plain', size_bytes: 6, readable: true, truncated: false, created_at: '2026-10-01T00:00:00Z', text_content: 'casual' }
  const system = () => h.toolRunner.mock.calls[0][0].system as unknown

  it('without a project the system prompt is the plain cached string', async () => {
    fakeRunner([{ text: 'ok' }])
    await events(await post('hi'))
    expect(typeof system()).toBe('string')
    expect(h.itemsForBlock).not.toHaveBeenCalled()
  })

  it("an existing chat in a project gets that project's block after the stable prompt, each block cached", async () => {
    h.getConversation.mockResolvedValue({ id: CONV, title: 'Old', created_at: '', updated_at: '', project_id: PID })
    h.getProject.mockImplementation(async (id: string) => (id === PID ? roofers : null))
    h.itemsForBlock.mockResolvedValue([note])
    fakeRunner([{ text: 'ok' }])
    const ev = await events(await post('next', { conversation_id: CONV }))
    expect(h.itemsForBlock).toHaveBeenCalledWith(PID)
    const blocks = system() as { type: string; text: string; cache_control?: unknown }[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1].text).toContain('Project: Roofers Austin')
    expect(blocks[1].text).toContain('Never order more than 2k.')
    expect(blocks[1].text).toContain('casual')
    // The per-run user turn carries no project text (it stays in the cached prefix).
    expect(h.toolRunner.mock.calls[0][0].messages[0].content).not.toContain('Roofers Austin')
    expect(ev[0]).toMatchObject({ type: 'run', conversation_id: CONV, project_id: PID })
  })

  it("read_project_file reads from the chat's own project", async () => {
    h.getConversation.mockResolvedValue({ id: CONV, title: 'Old', created_at: '', updated_at: '', project_id: PID })
    h.getProject.mockResolvedValue(roofers)
    h.fetch.mockResolvedValue(new Response('{"text":"abc"}'))
    process.env.LUME_INTERNAL_SECRET = 's'
    fakeRunner([{ text: 'reading', call: { name: 'read_project_file', input: { id: FID } } }, { text: 'done' }])
    await events(await post('read it', { conversation_id: CONV }))
    expect(String(h.fetch.mock.calls[0][0])).toContain(`/api/agent/projects/${PID}/files/${FID}?offset=0`)
  })

  it('"New chat in project": the new conversation is filed there', async () => {
    h.getProject.mockImplementation(async (id: string) => (id === PID ? roofers : null))
    fakeRunner([{ text: 'ok' }])
    await events(await post('hello', { project_id: PID }))
    expect(h.createConversation).toHaveBeenCalledWith('hello', undefined, PID)
    expect(Array.isArray(system())).toBe(true)
  })

  it('an unknown project_id is 404 and creates nothing', async () => {
    const res = await post('hello', { project_id: PID })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'project_not_found' })
    expect(h.createConversation).not.toHaveBeenCalled()
    expect(h.insertAgentRun).not.toHaveBeenCalled()
  })

  it("the owner's /operator chat for a vertical auto-files into the vertical's linked project", async () => {
    h.getVertical.mockResolvedValue({ id: VID, name: 'Roofers', campaign_ids: [] })
    h.projectForVertical.mockImplementation(async (v: string) => (v === VID ? { id: PID, name: 'Roofers Austin' } : null))
    h.getProject.mockResolvedValue(roofers)
    fakeRunner([{ text: 'ok' }])
    await events(await post('How are we doing?', { vertical_id: VID }))
    expect(h.createConversation).toHaveBeenCalledWith('How are we doing?', { vertical_id: VID, operator_id: null }, PID)
    expect((system() as { text: string }[])[1].text).toContain('Roofers Austin')
  })

  it("a vertical Grok Bot's new chat auto-files into its vertical's project", async () => {
    h.currentOperator.mockResolvedValue({ id: 'op-1', vertical_id: 'v-roof', is_master: false, label: 'Roofers bot', revoked_at: null })
    h.getVertical.mockResolvedValue({ id: 'v-roof', name: 'Roofers', campaign_ids: [] })
    h.projectForVertical.mockImplementation(async (v: string) => (v === 'v-roof' ? { id: PID, name: 'Roofers Austin' } : null))
    h.getProject.mockResolvedValue(roofers)
    fakeRunner([{ text: 'ok' }])
    await events(await post('What needs me?'))
    expect(h.createConversation).toHaveBeenCalledWith('What needs me?', { vertical_id: 'v-roof', operator_id: 'op-1' }, PID)
  })

  it('a vertical with no linked project stays Unfiled', async () => {
    h.getVertical.mockResolvedValue({ id: VID, name: 'Roofers', campaign_ids: [] })
    fakeRunner([{ text: 'ok' }])
    await events(await post('hi', { vertical_id: VID }))
    expect(h.createConversation).toHaveBeenCalledWith('hi', { vertical_id: VID, operator_id: null })
    expect(typeof system()).toBe('string')
  })

  describe('a vertical Grok Bot', () => {
    const OTHER = '9a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    const bot = { id: 'op-1', vertical_id: 'v-roof', is_master: false, label: 'Roofers bot', revoked_at: null }
    beforeEach(() => {
      h.currentOperator.mockResolvedValue(bot)
      h.getVertical.mockResolvedValue({ id: 'v-roof', name: 'Roofers', campaign_ids: [] })
    })

    it("may start a chat in its own vertical's project", async () => {
      h.projectForVertical.mockResolvedValue({ id: PID, name: 'Roofers Austin' })
      h.getProject.mockResolvedValue({ ...roofers, vertical_id: 'v-roof' })
      fakeRunner([{ text: 'ok' }])
      await events(await post('hi', { project_id: PID }))
      expect(h.createConversation).toHaveBeenCalledWith('hi', { vertical_id: 'v-roof', operator_id: 'op-1' }, PID)
    })

    it("any other project_id is 403 and nothing is created", async () => {
      h.projectForVertical.mockResolvedValue({ id: PID, name: 'Roofers Austin' })
      h.getProject.mockResolvedValue({ ...roofers, id: OTHER, vertical_id: 'v-dent' })
      const res = await post('hi', { project_id: OTHER })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden_project' })
      expect(h.createConversation).not.toHaveBeenCalled()
      expect(h.insertAgentRun).not.toHaveBeenCalled()
    })

    it('with no linked project, any project_id is 403', async () => {
      expect((await post('hi', { project_id: PID })).status).toBe(403)
    })

    it("an existing chat filed in another vertical's project gets no block and no project tool scope", async () => {
      h.getConversation.mockResolvedValue({ id: CONV, title: 'Old', created_at: '', updated_at: '', project_id: OTHER })
      h.getProject.mockResolvedValue({ ...roofers, id: OTHER, vertical_id: 'v-dent' })
      h.itemsForBlock.mockResolvedValue([note])
      fakeRunner([{ text: 'ok' }])
      await events(await post('next', { conversation_id: CONV }))
      expect(typeof system()).toBe('string')
      expect(h.itemsForBlock).not.toHaveBeenCalled()
    })
  })

  it('a project that fails to load never blocks the run (no block, logged)', async () => {
    h.getConversation.mockResolvedValue({ id: CONV, title: 'Old', created_at: '', updated_at: '', project_id: PID })
    h.getProject.mockResolvedValue(roofers)
    h.itemsForBlock.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeRunner([{ text: 'ok' }])
    await events(await post('next', { conversation_id: CONV }))
    expect(typeof system()).toBe('string')
  })
})
