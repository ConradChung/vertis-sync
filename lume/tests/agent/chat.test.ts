import { describe, expect, it } from 'vitest'
import { buildPrompt, parseSseFrames, PROMPT_MAX } from '@/lib/agent/chat'
import { applyAgentEvent, type ChatMessage } from '@/hooks/useAgentChat'

describe('parseSseFrames', () => {
  it('parses complete frames and keeps the partial tail', () => {
    const { events, rest } = parseSseFrames('data: {"type":"run","id":"r1"}\n\ndata: {"type":"text","delta":"Hi"}\n\ndata: {"type":"te')
    expect(events).toEqual([
      { type: 'run', id: 'r1' },
      { type: 'text', delta: 'Hi' },
    ])
    expect(rest).toBe('data: {"type":"te')
  })
  it('skips malformed and typeless frames', () => {
    expect(parseSseFrames('data: nope\n\n: ping\n\ndata: {"x":1}\n\n').events).toEqual([])
  })
})

describe('buildPrompt', () => {
  it('sends the message as-is with no history', () => {
    expect(buildPrompt([], '  hi  ')).toBe('hi')
  })
  it('prefixes labelled context and stays under the route cap', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `turn ${i} ${'x'.repeat(500)}` }))
    const p = buildPrompt(history, 'what now?')
    expect(p.length).toBeLessThanOrEqual(PROMPT_MAX)
    expect(p).toMatch(/^Earlier in this conversation/)
    expect(p.endsWith('Current request:\nwhat now?')).toBe(true)
    expect(p).toContain('turn 39') // newest kept
    expect(p).not.toContain('turn 0 ') // oldest dropped
  })
})

describe('applyAgentEvent', () => {
  const empty: ChatMessage = { id: 'a', role: 'assistant', text: '', tools: [], approvals: [] }
  it('folds text, tools and approvals', () => {
    const m = [
      { type: 'text', delta: 'Checking ' },
      { type: 'tool_start', id: 't1', name: 'list_orders', tier: 'read' },
      { type: 'tool_end', id: 't1', ok: true, ms: 420 },
      { type: 'tool_start', id: 't2', name: 'pause_campaign', tier: 'high' },
      { type: 'tool_end', id: 't2', ok: true, ms: 80 },
      { type: 'approval', action_id: 'act1', summary: 'Pause X', tool: 'pause_campaign' },
      { type: 'text', delta: 'done.' },
    ].reduce(applyAgentEvent, empty)
    expect(m.text).toBe('Checking done.')
    expect(m.tools.map((t) => t.status)).toEqual(['ok', 'awaiting'])
    expect(m.approvals).toEqual([{ action_id: 'act1', deep_link: '/actions/act1', summary: 'Pause X', tool: 'pause_campaign' }])
  })
  it('records run errors', () => {
    expect(applyAgentEvent(empty, { type: 'error', message: 'boom' }).error).toBe('boom')
  })
})
