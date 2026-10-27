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
}))

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
vi.mock('@/lib/actions/store', () => ({ claimDecision: h.claimDecision }))
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

import { POST } from '@/app/api/agent/run/route'

type FakeTool = { name: string; run: (input: unknown, ctx: unknown) => Promise<unknown> }

/** One streamed turn: optionally runs tools (as the runner would), then yields a fake message stream. */
function fakeRunner(turns: { text: string; call?: { name: string; input: unknown } }[]) {
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
          await tool.run(turn.call.input, { toolUse: { id: `tu-${turn.call.name}` } })
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
  process.env.ANTHROPIC_API_KEY = 'test-key'
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
    expect(h.executeAction).toHaveBeenCalledWith('act-1')
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

  it('a failed execution is auto_failed and its tool entry an error', async () => {
    h.executeAction.mockResolvedValue({ ran: true, status: 'failed', result: {}, error: 'instantly 500' })
    fakeRunner(pause)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', state: 'auto_failed' }))
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'done' })
    expect(h.insertMessage.mock.calls.at(-1)![0].tools).toEqual([expect.objectContaining({ status: 'error' })])
  })

  it('a lost claim reports not_claimable and runs nothing', async () => {
    h.claimDecision.mockResolvedValue(null)
    fakeRunner(pause)
    const ev = await events(await post('pause c1', { skip_permissions: true }))
    expect(h.executeAction).not.toHaveBeenCalled()
    expect(ev).toContainEqual(expect.objectContaining({ type: 'approval', state: 'auto_failed' }))
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
