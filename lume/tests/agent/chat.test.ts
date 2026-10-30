import { describe, expect, it } from 'vitest'
import { buildMessages, HISTORY_MAX_CHARS, MESSAGE_MAX, parseSseFrames, TURN_MAX_CHARS } from '@/lib/agent/chat'
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

describe('buildMessages', () => {
  const text = (m: { content: unknown }) => (m.content as { text: string }[])[0].text
  it('sends the message alone with no history', () => {
    const m = buildMessages([], '  hi  ')
    expect(m).toHaveLength(1)
    expect(m[0].role).toBe('user')
    expect(text(m[0])).toBe('hi')
  })
  it('keeps earlier turns as real alternating turns, full text', () => {
    const long = 'Variant A: ' + 'x'.repeat(5000)
    const m = buildMessages([{ role: 'user', text: 'draft step 1' }, { role: 'assistant', text: long }], 'mix A with the pain points')
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user'])
    expect(text(m[1])).toBe(long) // not clipped to a snippet
    expect(text(m[2])).toBe('mix A with the pain points')
  })
  it('merges consecutive same-role turns and starts with the owner', () => {
    const m = buildMessages(
      [
        { role: 'assistant', text: 'orphan' },
        { role: 'user', text: 'a' },
        { role: 'user', text: 'b' },
        { role: 'assistant', text: 'c' },
      ],
      'd'
    )
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user'])
    expect(text(m[0])).toContain('a')
    expect(text(m[0])).toContain('b')
    expect(text(m[0])).not.toContain('orphan')
  })
  it('folds a trailing owner turn into the current message so roles alternate', () => {
    const m = buildMessages([{ role: 'user', text: 'unanswered' }], 'again')
    expect(m.map((x) => x.role)).toEqual(['user'])
    expect(text(m[0])).toContain('unanswered')
    expect(text(m[0]).endsWith('again')).toBe(true)
  })
  it('drops the oldest turns past the budget and says so', () => {
    const history = Array.from({ length: 200 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `turn ${i} ${'x'.repeat(5000)}` }))
    const m = buildMessages(history, 'now')
    const all = m.map(text).join('\n')
    expect(all.length).toBeLessThanOrEqual(HISTORY_MAX_CHARS + 2000)
    expect(all).toContain('turn 199')
    expect(all).not.toContain('turn 0 ')
    expect(text(m[0])).toMatch(/earlier turns .*omitted/i)
    expect(m[0].role).toBe('user')
  })
  it('caps one huge turn instead of dropping everything', () => {
    const m = buildMessages([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'y'.repeat(TURN_MAX_CHARS * 3) }], 'next')
    expect(text(m[1]).length).toBeLessThanOrEqual(TURN_MAX_CHARS + 100)
    expect(text(m[1])).toMatch(/truncated/)
  })
  it('allows long pasted messages', () => {
    expect(MESSAGE_MAX).toBeGreaterThanOrEqual(50000)
    const big = 'p'.repeat(MESSAGE_MAX)
    expect(text(buildMessages([], big)[0])).toHaveLength(MESSAGE_MAX)
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
  it("keeps an approval's skip-mode state", () => {
    const m = applyAgentEvent(empty, { type: 'approval', action_id: 'act1', summary: 'Paused X', tool: 'pause_campaign', state: 'auto_executed' })
    expect(m.approvals[0]).toMatchObject({ action_id: 'act1', state: 'auto_executed' })
  })
  it('records run errors', () => {
    expect(applyAgentEvent(empty, { type: 'error', message: 'boom' }).error).toBe('boom')
  })
})
