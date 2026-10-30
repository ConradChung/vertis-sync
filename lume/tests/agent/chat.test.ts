import { describe, expect, it } from 'vitest'
import { buildMessages, HISTORY_IMAGE_MAX, HISTORY_IMAGE_TURNS, HISTORY_MAX_CHARS, MESSAGE_MAX, parseSseFrames, selectReplayImages, TURN_MAX_CHARS, type ContextTurn, type LoadedImage } from '@/lib/agent/chat'
import type { ChatImageRef } from '@/lib/agent/images'
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

describe('buildMessages with images', () => {
  type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } }
  const blocks = (m: { content: unknown }) => m.content as Block[]
  const ref = (n: number): ChatImageRef => ({ path: `0f3c2b1a-9d8e-4f7a-8b6c-${String(n).padStart(12, '0')}.png`, name: `shot-${n}.png`, media_type: 'image/png' })
  const loaded = (r: ChatImageRef): LoadedImage => ({ ...r, data: `b64-${r.name}` })

  it('puts the current images before the text, as base64 image blocks', () => {
    const m = buildMessages([], 'what is wrong here?', { current: [loaded(ref(1)), loaded(ref(2))] })
    expect(m).toHaveLength(1)
    const b = blocks(m[0])
    expect(b.map((x) => x.type)).toEqual(['image', 'image', 'text'])
    expect(b[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'b64-shot-1.png' })
    expect(b[1].source?.data).toBe('b64-shot-2.png')
    expect(b[2].text).toBe('what is wrong here?')
  })

  it('sends an image-only message with no empty text block', () => {
    const b = blocks(buildMessages([], '   ', { current: [loaded(ref(1))] })[0])
    expect(b.map((x) => x.type)).toEqual(['image'])
  })

  it('replays a loaded history image in its own turn and notes the ones not loaded', () => {
    const history: ContextTurn[] = [
      { role: 'user', text: 'old one', images: [ref(1)] },
      { role: 'assistant', text: 'seen' },
      { role: 'user', text: 'new one', images: [ref(2)] },
      { role: 'assistant', text: 'seen too' },
    ]
    const m = buildMessages(history, 'compare', { loaded: new Map([[ref(2).path, loaded(ref(2))]]) })
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    const first = blocks(m[0])
    expect(first.map((x) => x.type)).toEqual(['text'])
    expect(first[0].text).toContain('[image omitted: shot-1.png]')
    expect(first[0].text).toContain('old one')
    const third = blocks(m[2])
    expect(third.map((x) => x.type)).toEqual(['image', 'text'])
    expect(third[0].source?.data).toBe('b64-shot-2.png')
  })

  it('keeps an image-only history turn (its note or image stands in for the text)', () => {
    const m = buildMessages([{ role: 'user', text: '', images: [ref(1)] }, { role: 'assistant', text: 'ok' }], 'next')
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user'])
    expect(blocks(m[0])[0].text).toBe('[image omitted: shot-1.png]')
  })

  it('folds an unanswered owner turn, images included, into the current message', () => {
    const m = buildMessages([{ role: 'user', text: 'first', images: [ref(1)] }], 'again', {
      loaded: new Map([[ref(1).path, loaded(ref(1))]]),
      current: [loaded(ref(2))],
    })
    expect(m).toHaveLength(1)
    const b = blocks(m[0])
    expect(b.map((x) => x.type)).toEqual(['image', 'image', 'text'])
    expect(b[0].source?.data).toBe('b64-shot-1.png')
    expect(b[1].source?.data).toBe('b64-shot-2.png')
    expect(b[2].text).toBe('first\n\nagain')
  })

  it('images do not eat the text budget; a turn dropped for length takes its images with it', () => {
    const filler: ContextTurn[] = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? 'user' : 'assistant') as 'user' | 'assistant', text: 'y'.repeat(30_000) }))
    const history: ContextTurn[] = [
      { role: 'user', text: 'oldest', images: [ref(1)] },
      ...filler,
      { role: 'user', text: 'short', images: [ref(2)] },
      { role: 'assistant', text: 'b' },
    ]
    const loadedAll = new Map(history.flatMap((t) => t.images ?? []).map((r) => [r.path, loaded(r)]))
    const m = buildMessages(history, 'now', { loaded: loadedAll })
    const all = m.flatMap(blocks)
    expect(all.filter((b) => b.type === 'image').map((b) => b.source?.data)).toEqual(['b64-shot-2.png'])
    expect(blocks(m[0]).at(-1)?.text).toMatch(/omitted for length/)
  })
})

describe('selectReplayImages', () => {
  const ref = (n: number): ChatImageRef => ({ path: `0f3c2b1a-9d8e-4f7a-8b6c-${String(n).padStart(12, '0')}.png`, name: `s${n}.png`, media_type: 'image/png' })
  it('keeps the images of the last few owner turns, newest first, within the cap', () => {
    const history: ContextTurn[] = []
    for (let i = 1; i <= 6; i++) {
      history.push({ role: 'user', text: `t${i}`, images: [ref(i * 10 + 1), ref(i * 10 + 2)] })
      history.push({ role: 'assistant', text: 'ok' })
    }
    const picked = selectReplayImages(history).map((r) => r.path)
    expect(picked.length).toBeLessThanOrEqual(HISTORY_IMAGE_MAX)
    // Only the newest HISTORY_IMAGE_TURNS turns with images contribute.
    expect(picked).toContain(ref(61).path)
    expect(picked).toContain(ref(62).path)
    expect(picked).not.toContain(ref(11).path)
    expect(picked).not.toContain(ref(31).path)
    expect(HISTORY_IMAGE_TURNS).toBeLessThanOrEqual(3)
  })
  it('stops at the image cap even inside the newest turn', () => {
    const many = Array.from({ length: HISTORY_IMAGE_MAX + 3 }, (_, i) => ref(i + 1))
    const picked = selectReplayImages([{ role: 'user', text: '', images: many }])
    expect(picked).toHaveLength(HISTORY_IMAGE_MAX)
  })
  it('ignores assistant turns and turns without images', () => {
    expect(selectReplayImages([{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }])).toEqual([])
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
