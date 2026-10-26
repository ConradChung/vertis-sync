import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * /api/agent/run with the Anthropic SDK, the DB writes, createAction and
 * Telegram all mocked: no network, no live writes, no Claude calls.
 */

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  insertAgentRun: vi.fn(),
  updateAgentRun: vi.fn(),
  createAction: vi.fn(),
  logEvent: vi.fn(),
  sendMessage: vi.fn(),
  fetch: vi.fn(),
  toolRunner: vi.fn(),
}))

vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/agent/runs', () => ({ insertAgentRun: h.insertAgentRun, updateAgentRun: h.updateAgentRun }))
vi.mock('@/lib/actions/create', () => ({ createAction: h.createAction }))
vi.mock('@/lib/db/service', () => ({ logEvent: h.logEvent, isDbError: () => false }))
vi.mock('@/lib/adapters/telegram', () => ({ sendMessage: h.sendMessage }))
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

function post(prompt: string) {
  return POST(new Request('https://lume.test/api/agent/run', { method: 'POST', body: JSON.stringify({ prompt }) }))
}

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
  h.createAction.mockResolvedValue({ id: 'act-1' })
  h.logEvent.mockResolvedValue(null)
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

  it('streams text and finishes done with usage', async () => {
    fakeRunner([{ text: 'All quiet.' }])
    const res = await post('status?')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const ev = await events(res)
    expect(ev[0]).toEqual({ type: 'run', id: 'run-1' })
    expect(ev).toContainEqual({ type: 'text', delta: 'All quiet.' })
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'done' })
    expect(h.toolRunner.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5-5', stream: true, thinking: { type: 'adaptive' } })
    expect(h.insertAgentRun).toHaveBeenCalledWith('status?', 'claude-opus-5-5')
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
})
